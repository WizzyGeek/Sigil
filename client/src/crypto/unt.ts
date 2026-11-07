/**
 * UNT (Unified Note Token) assembly and verification.
 *
 * Wire format: [payload_object, sig_b64] — 2-part JSON array.
 * The stake (inner frame) is embedded in the outer payload as a nested [stake_payload, sig_b64].
 *
 * Verification (4 steps):
 *   1. Parse outer frame — extract payload and stake
 *   2. Verify stake with registry public key → trusted stake claims
 *   3. Verify outer with stake.public_key → trusted outer claims
 *   4. Verify stake_iat == stake.iat, deduplicate by jti, compute freshness
 *
 * Only the registry public key is needed — no network calls at verify time.
 */

import { signFrame, verifyFrame, importPublicKeyPem } from './jwt'
import { verifyStake, type RegistryKeyring } from './registryTrust'
import { fingerprintFromSpki } from './fingerprint'
import type { UNTOuterClaims, UNTInnerClaims, UNTFrame, StakeFrame, Note, FreshnessScore } from '../types/protocol'

/** Build and sign a note UNT. Stake is the 2-part frame from the registry. */
export async function buildUnt(
  content: string,
  channel: string,
  stake: StakeFrame,
  privateKey: CryptoKey,
  replyTo?: string,
): Promise<UNTFrame> {
  const payload: UNTOuterClaims = {
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    type: 'note',
    channel,
    content,
    reply_to: replyTo ?? null,
    stake,
    stake_iat: stake[0].iat,
  }
  return signFrame(payload as unknown as Record<string, unknown>, privateKey)
}

/** Build and sign a control UNT (subscribe / unsubscribe / request_notes / note_relay). */
export async function buildCommand(
  type: 'subscribe' | 'unsubscribe' | 'request_notes' | 'note_relay',
  channel: string,
  stake: StakeFrame,
  privateKey: CryptoKey,
  extra?: Record<string, unknown>,
): Promise<UNTFrame> {
  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    type,
    channel,
    stake,
    stake_iat: stake[0].iat,
    ...extra,
  }
  return signFrame(payload, privateKey)
}

/** Verify both signatures and the stake binding for notes and control frames. */
export async function verifyUntFrame(
  frame: UNTFrame,
  registryKeys: RegistryKeyring,
): Promise<{ outer: UNTOuterClaims; inner: UNTInnerClaims }> {
  if (!Array.isArray(frame) || frame.length !== 2 || !frame[0] || typeof frame[0] !== 'object' || typeof frame[1] !== 'string') {
    throw new Error('Invalid UNT frame')
  }
  const [outerPayload, outerSig] = frame
  const outer = outerPayload as unknown as UNTOuterClaims
  if (typeof outer.jti !== 'string' || !outer.jti || typeof outer.channel !== 'string' || !outer.channel || !Number.isSafeInteger(outer.iat) || outer.iat <= 0) throw new Error('Invalid UNT claims')
  const inner = await verifyStake(outer.stake, registryKeys)
  const authorKey = await importPublicKeyPem(inner.public_key)
  await verifyFrame<UNTOuterClaims>([outerPayload, outerSig], authorKey)
  if (outer.stake_iat !== inner.iat) throw new Error('stake_iat mismatch — possible stake swap attack')
  return { outer, inner }
}

/** Verify a note using only the key bound to its stake issuer. */
export async function verifyUnt(frame: UNTFrame, registryKeys: RegistryKeyring): Promise<Note> {
  const { outer, inner } = await verifyUntFrame(frame, registryKeys)
  if (outer.type !== 'note') throw new Error('Expected a note UNT')

  // Derive fingerprint from PEM bytes directly — PEM body IS the SPKI DER
  const spkiBytes = Uint8Array.from(
    atob(inner.public_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')),
    c => c.charCodeAt(0),
  )
  const authorFp = 'sha256:' + await fingerprintFromSpki(spkiBytes.buffer)

  return {
    jti: outer.jti,
    channel: outer.channel,
    displayName: inner.display_name ?? undefined,
    replyTo: outer.reply_to ?? undefined,
    body: outer.content ?? '',
    author: `${inner.user_tag}@${inner.iss}`,
    authorFp,
    registry: inner.iss,
    issuedAt: outer.iat,
    freshnessScore: computeFreshnessScore(outer.iat - inner.iat),
    raw: JSON.stringify(frame),
  }
}

function computeFreshnessScore(deltaT: number): FreshnessScore {
  if (deltaT < 5)     return 5
  if (deltaT < 30)    return 4
  if (deltaT < 180)   return 3
  if (deltaT < 1800)  return 2
  if (deltaT < 86400) return 1
  return 0
}
