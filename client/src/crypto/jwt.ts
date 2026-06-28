/**
 * Minimal RS256 JWT construction and verification using Web Crypto API.
 * No external library — per protocol spec.
 */

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function b64urlEncode(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function b64urlDecode(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return atob(s)
}

const HEADER = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))

/** Sign a payload with the given CryptoKey (RSASSA-PKCS1-v1_5). */
export async function signJwt(payload: Record<string, unknown>, privateKey: CryptoKey): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload))
  const signingInput = `${HEADER}.${body}`
  const enc = new TextEncoder()
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(signingInput))
  return `${signingInput}.${b64url(sig)}`
}

/** Verify a JWT against a CryptoKey (RSASSA-PKCS1-v1_5) and return its payload. */
export async function verifyJwt(token: string, publicKey: CryptoKey): Promise<Record<string, unknown>> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  const [header, body, sigB64] = parts
  const enc = new TextEncoder()
  const signingInput = enc.encode(`${header}.${body}`)
  const sig = Uint8Array.from(b64urlDecode(sigB64), c => c.charCodeAt(0))
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sig, signingInput)
  if (!valid) throw new Error('JWT signature invalid')
  return JSON.parse(b64urlDecode(body))
}

/** Decode a JWT without verifying (for inspecting claims). */
export function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  return JSON.parse(b64urlDecode(parts[1]))
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
