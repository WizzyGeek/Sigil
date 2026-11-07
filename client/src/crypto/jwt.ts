/**
 * Frame signing and verification using Web Crypto (RSASSA-PKCS1-v1_5 RS256).
 * No base64url, no JWT compact form — wire format is [payload_object, sig_b64].
 *
 * Signing input: canonical JSON of the payload (keys sorted recursively).
 * Signature: base64-encoded RSA-4096 PKCS1v15 SHA-256.
 */

import type { UNTFrame } from '../types/protocol'

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalJson)
  const obj = value as Record<string, unknown>
  const sorted: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalJson(obj[key])
  }
  return sorted
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalJson(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** Sign a payload object. Returns a 2-part frame [payload, sig_b64]. */
export async function signFrame(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
): Promise<UNTFrame> {
  const bytes = new TextEncoder().encode(canonicalJsonString(payload))
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, bytes)
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
  return [payload, sig]
}

/** Verify a [payload, sig_b64] frame. Throws if invalid. Returns the trusted payload. */
export async function verifyFrame<T>(
  frame: [unknown, string],
  publicKey: CryptoKey,
): Promise<T> {
  const [payload, sigB64] = frame
  const bytes = new TextEncoder().encode(canonicalJsonString(payload))
  const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0))
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sig, bytes)
  if (!valid) throw new Error('signature invalid')
  return payload as T
}

/** Import a PEM public key for verification. */
export async function importPublicKeyPem(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s/g, '')
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  return crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}
