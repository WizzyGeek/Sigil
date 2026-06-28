/** Raw UNT as received over the wire — a signed JWT string. */
export type UNTString = string

/** Decoded outer UNT claims (author-signed). */
export interface UNTOuterClaims {
  iss: string        // author fingerprint
  sub: string        // channel
  iat: number
  exp: number
  jti: string        // unique note id (dedup key)
  body: string       // note text
  inner: string      // inner JWT (registry-signed stake)
}

/** Decoded inner UNT claims (registry stake). */
export interface UNTInnerClaims {
  iss: string        // registry domain
  sub: string        // author fingerprint
  handle: string     // @user@registry
  iat: number
  exp: number
  jti: string
}

/** A fully verified, decoded UNT ready for display. */
export interface Note {
  jti: string
  channel: string
  body: string
  author: string      // handle
  authorFp: string    // fingerprint
  registry: string
  issuedAt: number
  freshnessScore: FreshnessScore
  raw: UNTString
}

/** Freshness score 0–5 (number of locks). */
export type FreshnessScore = 0 | 1 | 2 | 3 | 4 | 5

/** WebSocket message types from the broker. */
export type ServerCommand =
  | { type: 'note_response'; unt: UNTString }
  | { type: 'revoke_key'; fingerprint: string }
  | { type: 'error'; message: string }

/** WebSocket message types sent to the broker. */
export type ClientCommand =
  | { type: 'subscribe'; channel: string; unt: UNTString }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'request_notes'; channel: string; since?: number }
  | { type: 'note_response'; channel: string; unt: UNTString }
