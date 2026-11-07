import { openDB, IDBPDatabase } from 'idb'

const DB_NAME = 'sigil-keystore'
const DB_VERSION = 1
const STORE = 'keys'

export interface KeyRecord {
  id: string
  privateKey: CryptoKey      // non-extractable
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

/** Generate a non-extractable RSA keypair without replacing a stored identity. */
export async function generateKeypair(id = 'primary'): Promise<KeyRecord> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 4096,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    false,  // non-extractable private key
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
  return (await store.get(STORE, id)) ?? null
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

export async function storeKeypair(record: KeyRecord): Promise<void> {
  await (await db()).put(STORE, record)
}
