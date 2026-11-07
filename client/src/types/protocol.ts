/** 2-part wire frame: [payload_object, sig_b64]. Every wire message is this shape. */
export type UNTFrame = [Record<string, unknown>, string]

/** 2-part stake frame embedded inside the outer payload. */
export type StakeFrame = [UNTInnerClaims, string]

export interface HistoryCursor { iat: number; jti: string }

/** Decoded outer UNT claims (author-signed). */
export interface UNTOuterClaims {
  jti: string
  iat: number
  type: 'note' | 'subscribe' | 'unsubscribe' | 'request_notes' | 'note_relay'
  channel: string
  stake: StakeFrame   // nested [stake_payload, sig_b64]
  stake_iat: number   // MUST equal stake[0].iat — bound into outer signature
  // note-only:
  content?: string
  reply_to?: string | null
  // request_notes-only:
  before?: HistoryCursor // strict (iat, jti) cursor for same-second pagination
  till?: number       // fetch notes with iat < till (defaults to now)
  // note_relay-only:
  peer_id?: string // responder session, or target session on a continuation request
  request_jti?: string // binds a relay to an outstanding request
  next_cursor?: HistoryCursor | null
  has_more?: boolean
  to?: string         // recipient fingerprint for unicast routing
  relays?: UNTFrame[] // batch of original [note_payload, sig] frames
}

/** Decoded inner stake claims (registry-signed). */
export interface UNTInnerClaims {
  iss: string          // registry domain — combine with user_tag for fully-qualified handle
  iat: number
  public_key: string   // author's RSA-4096 public key PEM — verifies the outer frame
  user_tag: string     // @handle (local part only)
  display_name: string | null
  // sub omitted — computable from public_key SPKI bytes
  // exp omitted — stake is a historical notarization, not an access token
}

/** A fully verified, decoded UNT note ready for display. */
export interface Note {
  jti: string
  channel: string
  body: string
  displayName?: string
  replyTo?: string
  author: string        // @handle@registry (fully-qualified)
  authorFp: string      // sha256:hex fingerprint
  registry: string
  issuedAt: number
  freshnessScore: FreshnessScore
  raw: string           // JSON.stringify of the original UNTFrame
}

/** Freshness score 0–5. delta_t = outer.iat − stake.iat */
export type FreshnessScore = 0 | 1 | 2 | 3 | 4 | 5
