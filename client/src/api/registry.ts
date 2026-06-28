/** Registry HTTP API client. */

const BASE = import.meta.env.VITE_REGISTRY_URL as string

export async function fetchRegistryPublicKey(): Promise<string> {
  const res = await fetch(`${BASE}/registry/public-key`)
  if (!res.ok) throw new Error('Failed to fetch registry public key')
  const data = await res.json()
  return data.public_key as string
}

export async function requestChallenge(fingerprint: string): Promise<{ nonce: string; expires_at: string }> {
  const res = await fetch(`${BASE}/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fingerprint }),
  })
  if (!res.ok) throw new Error('Challenge request failed')
  return res.json()
}

export async function register(payload: {
  public_key: string
  user_tag: string
  display_name?: string
  nonce: string
  signature: string
  recovery_email_hash?: string
}): Promise<{ fingerprint: string; handle: string }> {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? 'Registration failed')
  }
  return res.json()
}

export async function requestStake(payload: {
  fingerprint: string
  nonce: string
  signature: string
}): Promise<{ stake: string }> {
  const res = await fetch(`${BASE}/stake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error('Stake request failed')
  return res.json()
}

export async function lookupKey(fingerprint: string): Promise<{ public_key: string }> {
  const res = await fetch(`${BASE}/key/${encodeURIComponent(fingerprint)}`)
  if (!res.ok) throw new Error(`Key not found: ${fingerprint}`)
  return res.json()
}
