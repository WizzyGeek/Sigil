/**
 * UNT (Unified Note Token) assembly and 4-step verification.
 * Outer JWT: author-signed. Inner JWT: registry-signed stake embedded in outer payload.
 */

import { signJwt, verifyJwt, decodeJwt } from './jwt'
import type { UNTOuterClaims, UNTInnerClaims, Note, FreshnessScore } from '../types/protocol'

/** Build and sign a UNT. `stake` is the inner JWT from the registry. */
export async function buildUnt(
  body: string,
  channel: string,
  stake: string,
  privateKey: CryptoKey,
  authorFp: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: UNTOuterClaims = {
    iss: authorFp,
    sub: channel,
    iat: now,
    exp: now + 3600 * 24 * 365,
    jti: crypto.randomUUID(),
    body,
    inner: stake,
  }
  return signJwt(payload as unknown as Record<string, unknown>, privateKey)
}

/**
 * 4-step UNT verification:
 * 1. Decode outer claims without verifying (get author fingerprint + inner stake)
 * 2. Verify inner stake JWT with registry public key
 * 3. Confirm inner.sub matches outer.iss (same fingerprint)
 * 4. Fetch author public key from registry, verify outer signature
 */
export async function verifyUnt(
  unt: string,
  registryPublicKey: CryptoKey,
  fetchAuthorKey: (fp: string) => Promise<CryptoKey>,
): Promise<Note> {
  // Step 1: Decode outer (unverified) to get iss and inner stake
  const outerRaw = decodeJwt(unt) as unknown as UNTOuterClaims

  // Step 2: Verify inner stake with registry key
  const innerClaims = await verifyJwt(outerRaw.inner, registryPublicKey) as unknown as UNTInnerClaims

  // Step 3: Stake sub must match outer iss
  if (innerClaims.sub !== outerRaw.iss) {
    throw new Error('UNT stake fingerprint mismatch')
  }

  // Step 4: Fetch and verify outer with author public key
  const authorKey = await fetchAuthorKey(outerRaw.iss)
  await verifyJwt(unt, authorKey)

  const now = Math.floor(Date.now() / 1000)
  const freshnessScore = computeFreshnessScore(outerRaw.iat, now)

  return {
    jti: outerRaw.jti,
    channel: outerRaw.sub,
    body: outerRaw.body,
    author: innerClaims.handle,
    authorFp: outerRaw.iss,
    registry: innerClaims.iss,
    issuedAt: outerRaw.iat,
    freshnessScore,
    raw: unt,
  }
}

/** Compute freshness score (0–5 locks) based on how recently the note was issued. */
function computeFreshnessScore(iat: number, now: number): FreshnessScore {
  const ageSeconds = now - iat
  if (ageSeconds < 60)        return 5
  if (ageSeconds < 300)       return 4
  if (ageSeconds < 3600)      return 3
  if (ageSeconds < 86400)     return 2
  if (ageSeconds < 86400 * 7) return 1
  return 0
}
