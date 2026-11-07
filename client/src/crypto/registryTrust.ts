/** Registry authorities are bound to keys fetched from their configured URLs. */
import { verifyFrame } from './jwt'
import type { StakeFrame, UNTInnerClaims } from '../types/protocol'

export type RegistryKeyring = ReadonlyMap<string, CryptoKey>

export function registryIssuer(registryUrl: string): string {
  const url = new URL(registryUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid registry URL')
  return url.host.toLowerCase()
}

export function createRegistryKeyring(entries: Iterable<readonly [string, CryptoKey]>): RegistryKeyring {
  const keys = new Map<string, CryptoKey>()
  for (const [url, key] of entries) {
    const issuer = registryIssuer(url)
    if (keys.has(issuer)) throw new Error(`Multiple configured registry URLs use issuer ${issuer}. Configure one URL per issuer.`)
    keys.set(issuer, key)
  }
  return keys
}

export async function verifyStake(stake: StakeFrame, keys: RegistryKeyring): Promise<UNTInnerClaims> {
  if (!Array.isArray(stake) || stake.length !== 2 || !stake[0] || typeof stake[0].iss !== 'string' || typeof stake[1] !== 'string') {
    throw new Error('Invalid stake frame')
  }
  // Read iss only to select a key; no claims become trusted before verification.
  const issuer = stake[0].iss.toLowerCase()
  const key = keys.get(issuer)
  if (!key) throw new Error(`Unknown registry issuer: ${stake[0].iss}`)
  const claims = await verifyFrame<UNTInnerClaims>(stake, key)
  if (!Number.isSafeInteger(claims.iat) || claims.iat <= 0 || typeof claims.public_key !== 'string' || typeof claims.user_tag !== 'string' || (claims.display_name !== null && typeof claims.display_name !== 'string')) throw new Error('Invalid stake claims')
  return claims
}
