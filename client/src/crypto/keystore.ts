import { openDB, IDBPDatabase } from 'idb'

const DB_NAME = 'sigil-keystore'
const DB_VERSION = 1
const STORE = 'keys'

interface KeyRecord {
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

/** Generate and persist a new RSA-2048 keypair. Returns the record id. */
export async function generateAndStoreKeypair(id = 'primary'): Promise<KeyRecord> {
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
  const record: KeyRecord = { id, privateKey, publicKeySpki }
  const store = await db()
  await store.put(STORE, record)
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
