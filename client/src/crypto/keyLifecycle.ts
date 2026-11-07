import { requestChallenge, requestRotationChallenge, rotateKey, revokeKey, lookupKey, RegistryError } from '../api/registry'
import { fingerprintFromSpki } from './fingerprint'
import type { KeyRecord } from './keystore'

export async function signNonce(key: CryptoKey, nonce: string): Promise<string> {
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(nonce))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}
export function publicKeyPem(record: Pick<KeyRecord, 'publicKeySpki'>): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(record.publicKeySpki)))
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`
}

/** A lost HTTP response is recoverable: the same replacement key remains journaled. */
export async function rotateRegistry(url: string, oldFingerprint: string, oldKey: CryptoKey, replacement: KeyRecord, expectedHandle?: string): Promise<void> {
  const newFingerprint = await fingerprintFromSpki(replacement.publicKeySpki)
  try {
    const existing = await lookupKey(newFingerprint, url)
    if (existing.fingerprint !== newFingerprint || existing.public_key.trim() !== publicKeyPem(replacement).trim()) throw new Error('Registry returned a different replacement key.')
    if (expectedHandle !== undefined && existing.user_tag !== expectedHandle) throw new Error('The replacement key is registered under a different handle on this registry.')
    return
  } catch (error) { if (!(error instanceof RegistryError && error.status === 404)) throw error }
  const { nonce } = await requestRotationChallenge(oldFingerprint, url)
  const result = await rotateKey({
    old_fingerprint: oldFingerprint, new_public_key: publicKeyPem(replacement), nonce,
    old_signature: await signNonce(oldKey, nonce), new_signature: await signNonce(replacement.privateKey, nonce),
  }, url)
  if (result.new_fingerprint !== newFingerprint) throw new Error('Registry returned a different replacement fingerprint. Retry to check rotation status.')
}

/** 404 lookup also handles retry after a successful revocation whose reply was lost. */
export async function revokeRegistry(url: string, fingerprint: string, privateKey: CryptoKey): Promise<void> {
  try { await lookupKey(fingerprint, url) }
  catch (error) { if (error instanceof RegistryError && error.status === 404) return; throw error }
  const { nonce } = await requestChallenge(fingerprint, url)
  const result = await revokeKey({ fingerprint, nonce, signature: await signNonce(privateKey, nonce) }, url)
  if (result.revoked !== true) throw new Error('Registry did not confirm revocation.')
}

/** Serialize destructive identity operations across tabs on this origin. */
export async function withIdentityLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('Key management requires a browser with Web Locks support.')
  return navigator.locks.request('sigil-key-lifecycle', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('Key management is already running in another tab.')
    return work()
  })
}
