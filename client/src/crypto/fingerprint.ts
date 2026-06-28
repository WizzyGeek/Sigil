/** SHA-256 fingerprint of a public key's SPKI DER bytes, hex-encoded. */
export async function fingerprintFromSpki(spkiBytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', spkiBytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** SHA-256 hash of a lowercase-trimmed email address, hex-encoded. */
export async function hashEmail(email: string): Promise<string> {
  const enc = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(email.trim().toLowerCase()))
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
