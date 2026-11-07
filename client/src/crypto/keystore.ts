import { openDB, IDBPDatabase } from 'idb'
import type { RotationJournal } from './rotation'
import { loadPreferences } from '../store/preferences'
import { fingerprintFromSpki } from './fingerprint'

const DB_NAME = 'sigil-keystore'
const DB_VERSION = 1
const STORE = 'keys'

export interface KeyRecord {
  identityMetadata?: { fingerprint: string; handle: string; registryUrl?: string }
  rotation?: RotationJournal
  id: string
  privateKey: CryptoKey      // retained signing keys are non-extractable after backup acknowledgement
  publicKeySpki: ArrayBuffer // exported SPKI for sharing
}

let _db: IDBPDatabase | null = null

async function db(): Promise<IDBPDatabase> {
  if (!_db) {
    _db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      },
    })
  }
  return _db
}

/** Generate an RSA keypair without replacing a stored identity; temporary extraction is used only to prepare a one-time backup. */
export async function generateKeypair(id = 'primary', extractable = false): Promise<KeyRecord> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 4096,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    extractable,  // only the temporary backup preparation key needs extraction
    ['sign', 'verify'],
  )

  const publicKeySpki = await crypto.subtle.exportKey('spki', publicKey)
  return { id, privateKey, publicKeySpki }
}

/** Generate and persist under an explicitly chosen record id. */
export async function generateAndStoreKeypair(id = 'primary'): Promise<KeyRecord> {
  const record = await generateKeypair(id)
  await storeKeypair(record)
  return record
}

/** Load an existing keypair by id, or return null if not found. */
export async function loadKeypair(id = 'primary'): Promise<KeyRecord | null> {
  const store = await db()
  const exact = await store.get(STORE, id)
  if (exact) return exact
  // Compatibility for callers looking up cryptographic material by fingerprint.
  if (/^identity:[a-f0-9]{64}$/.test(id)) return (await listIdentityKeys()).find(record => record.identityMetadata?.fingerprint === id.slice(9)) ?? null
  return null
}

/** Delete a keypair (e.g. after revocation). */
export async function deleteKeypair(id = 'primary'): Promise<void> {
  const store = await db()
  await store.delete(STORE, id)
}

/** Import a PKCS#8 PEM backup; persist its private key as non-extractable. */
export async function importKeypair(pem: string): Promise<KeyRecord> {
  if (!pem.includes('-----BEGIN PRIVATE KEY-----')) throw new Error('Use an unencrypted PKCS#8 PEM key (BEGIN PRIVATE KEY).')
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), c => c.charCodeAt(0))
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  const temporary = await crypto.subtle.importKey('pkcs8', der, algorithm, true, ['sign'])
  const jwk = await crypto.subtle.exportKey('jwk', temporary)
  const publicKey = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, ext: true }, algorithm, true, ['verify'])
  const privateKey = await crypto.subtle.importKey('pkcs8', der, algorithm, false, ['sign'])
  return { id: 'primary', privateKey, publicKeySpki: await crypto.subtle.exportKey('spki', publicKey) }
}

export function identityRecordId(metadata: { fingerprint: string; handle: string; registryUrl?: string }): string {
  return `saved-identity:${JSON.stringify(metadata.registryUrl ? [metadata.registryUrl, metadata.handle] : [null, metadata.fingerprint])}`
}

export async function loadIdentityKey(identity: { fingerprint: string; registryUrl?: string; handle?: string }): Promise<KeyRecord | null> {
  if (identity.handle) {
    const record = await loadKeypair(identityRecordId({ ...identity, handle: identity.handle }))
    return record?.identityMetadata?.fingerprint === identity.fingerprint ? record : null
  }
  return (await listIdentityKeys()).find(record => record.identityMetadata?.fingerprint === identity.fingerprint && record.identityMetadata?.registryUrl === identity.registryUrl) ?? null
}

/** Each identity gets its own key record, even when its key bytes match another's. */
export async function storeKeypair(record: KeyRecord): Promise<void> {
  if (record.id !== 'primary') { await (await db()).put(STORE, record); return }
  const previous = await loadKeypair()
  const tx = (await db()).transaction(STORE, 'readwrite')
  if (previous?.identityMetadata) await tx.store.put({ ...previous, id: identityRecordId(previous.identityMetadata) })
  if (record.identityMetadata) {
    if (record.identityMetadata.registryUrl) await tx.store.delete(identityRecordId({ ...record.identityMetadata, registryUrl: undefined }))
    await tx.store.put({ ...record, id: identityRecordId(record.identityMetadata) })
  }
  await tx.store.put(record)
  await tx.done
}

export async function listIdentityKeys(): Promise<KeyRecord[]> {
  return (await (await db()).getAll(STORE)).filter((record: KeyRecord) => record.id.startsWith('saved-identity:'))
}

/** Expand the old per-fingerprint store into separate, independently deletable identities. */
export async function migrateIdentityRecords(fallback?: KeyRecord['identityMetadata']): Promise<void> {
  const records: KeyRecord[] = await (await db()).getAll(STORE)
  const existing = new Set(records.map(record => record.id))
  const migrated = new Map<string, KeyRecord>()
  let primary = records.find(record => record.id === 'primary')
  if (primary && !primary.identityMetadata && fallback) primary = { ...primary, identityMetadata: fallback }
  for (const record of [...records.filter(record => record.id.startsWith('identity:')), ...(primary ? [primary] : [])]) {
    const fingerprint = await fingerprintFromSpki(record.publicKeySpki)
    const metadata = record.identityMetadata
    if (record.id === 'primary' && metadata && existing.has(identityRecordId(metadata))) continue
    const preferences = loadPreferences(fingerprint, metadata?.registryUrl ? { url: metadata.registryUrl, handle: metadata.handle } : undefined)
    const accounts = preferences.registries.length ? preferences.registries : [{ url: undefined, handle: 'Unregistered key' }]
    for (const account of accounts) {
      const identityMetadata = { fingerprint, handle: account.handle, registryUrl: account.url }
      const id = identityRecordId(identityMetadata)
      if (!existing.has(id)) migrated.set(id, { ...record, id, identityMetadata })
    }
    if (record.id === 'primary') {
      const selected = accounts.find(account => account.url === metadata?.registryUrl) ?? accounts[0]
      primary = { ...record, identityMetadata: { fingerprint, handle: selected.handle, registryUrl: selected.url } }
    }
  }
  const tx = (await db()).transaction(STORE, 'readwrite')
  for (const record of migrated.values()) await tx.store.put(record)
  for (const record of records) if (record.id.startsWith('identity:')) await tx.store.delete(record.id)
  if (primary) await tx.store.put(primary)
  await tx.done
}

/** Atomically replace the selected identities' own copies and the active identity. */
export async function finishRotation(record: KeyRecord, replacements: KeyRecord[] = [record], _retired?: string[]): Promise<void> {
  for (const key of replacements) if (!key.identityMetadata) throw new Error('Replacement identity metadata is missing.')
  const { rotation, ...primary } = record
  const copies = (rotation?.jobs ?? replacements.map(key => ({ handle: key.identityMetadata!.handle, url: key.identityMetadata!.registryUrl, replacementFingerprint: key.identityMetadata!.fingerprint }))).map(job => {
    const replacement = replacements.find(key => key.identityMetadata!.fingerprint === job.replacementFingerprint)
    if (!replacement) throw new Error('A rotation replacement is missing.')
    const { rotation: _journal, ...key } = replacement
    const identityMetadata = { fingerprint: job.replacementFingerprint, handle: job.handle, registryUrl: job.url }
    return { ...key, id: identityRecordId(identityMetadata), identityMetadata }
  })
  const tx = (await db()).transaction(STORE, 'readwrite')
  for (const copy of copies) await tx.store.put(copy)
  await tx.store.put({ ...primary, id: 'primary' })
  await tx.store.delete('pending-rotation')
  await tx.done
}

/** Remove only this identity's saved key copy and its active-copy alias. */
export async function deleteStoredIdentity(identity: { fingerprint: string; handle: string; registryUrl?: string }): Promise<void> {
  const id = identityRecordId(identity)
  const primary = await loadKeypair()
  const tx = (await db()).transaction(STORE, 'readwrite')
  await tx.store.delete(id)
  if (primary?.identityMetadata && identityRecordId(primary.identityMetadata) === id) await tx.store.delete('primary')
  await tx.done
}

/** Delete every stored copy of this key, including duplicate staging records. */
export async function deleteIdentityKeys(fingerprint: string): Promise<void> {
  const database = await db()
  const records: KeyRecord[] = await database.getAll(STORE)
  const matching = await Promise.all(records.map(async record =>
    await fingerprintFromSpki(record.publicKeySpki) === fingerprint ? record.id : null))
  const tx = database.transaction(STORE, 'readwrite')
  for (const id of matching) if (id) await tx.store.delete(id)
  await tx.done
}

export async function hasLocalKeyMaterial(): Promise<boolean> {
  return (await (await db()).count(STORE)) > 0
}

/** Explicit client-wide wipe also removes staging keys and nested rotation replacements. */
export async function deleteAllLocalKeys(): Promise<void> {
  await (await db()).clear(STORE)
}

/** Export once in memory, then retain only a non-extractable signing key. */
export async function generateBackupKeypair(id: string): Promise<{ record: KeyRecord; pem: string }> {
  const temporary = await generateKeypair(id, true)
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', temporary.privateKey))
  try {
    const base64 = btoa(String.fromCharCode(...der))
    const pem = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`
    const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    return { record: { id, privateKey, publicKeySpki: temporary.publicKeySpki }, pem }
  } finally { der.fill(0) }
}
