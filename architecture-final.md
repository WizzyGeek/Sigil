# Decentralized Notes Protocol (DNP) — Architecture Reference
# Intended audience: LLM (Claude Code). Read fully before implementing anything.
# This document is the single source of truth. Do not infer or assume anything not stated here.

---

## WHAT THIS IS

A decentralized, cryptographically secure protocol for publishing and distributing signed notes
(similar to tweets) between users. Trust is entirely cryptographic. Servers are dumb infrastructure.
No server stores notes. Clients are the database.

---

## CORE PRINCIPLES — NEVER VIOLATE THESE

1. Private keys never leave the client device. Ever.
2. No server stores notes or UNTs. Ever.
3. Registry and Broker never communicate with each other. Ever.
4. Email is never stored in plaintext anywhere. Ever.
5. Email hash is never returned in any API response. Ever.
6. Registry stores only what is strictly necessary for current state. No history. No logs.
7. All trust is cryptographic. Servers are untrusted infrastructure.
8. Every payload received from the network must be independently verified before use.

---

## COMPONENTS

### REGISTRY
- One logical server (redundant nodes allowed with consensus, not in current scope).
- Stores current public keys mapped to user handles.
- Issues signed stakes (endorsements of public keys).
- Handles: registration, stake issuance, key lookup, key rotation, key revocation.
- Has its own RSA keypair. Its public key is baked into every client at install time.
- NEVER communicates with any Broker.
- NEVER stores note content, UNTs, or any user activity.
- NEVER stores email in plaintext.
- NEVER exposes email hash in any API response.
- Defines the namespace for one network. User handles are unique per registry.
- Fully qualified user identifier format: @handle@registry.example.com

### BROKER
- Stateless message relay. Stores absolutely nothing between connections.
- Receives UNTs from publishing clients, verifies them, fans out to subscribers.
- Forwards server command UNTs between clients (peer discovery, note requests).
- Has its own RSA keypair registered with the Registry (so clients can verify broker identity).
- Anyone can run a broker. Federated. No permission required.
- NEVER communicates with Registry.
- NEVER stores UNTs after relaying.
- Cannot read note content (it just forwards signed blobs it cannot tamper with).

### CLIENT
- Generates and holds RSA keypair locally. Private key never leaves device.
- Signs UNTs and server command UNTs.
- Stores all received valid UNTs locally (client is the database).
- Connects to one or more Brokers via WebSocket or SSE.
- Knows Registry public key at install time (baked in).
- Independently verifies every UNT received before storing or displaying it.
- Responds to forwarded request_notes commands by sending its stored UNTs back.

### BOOTSTRAP SERVER (Future — not in current scope)
- A server that behaves exactly like a client.
- Subscribes to the default channel ("*") only.
- Keeps up to 10MB of the most recent valid UNTs in memory.
- Responds to request_notes commands like a normal client.
- Purpose: ensures new clients can get some history even when no peers are online.
- Implement this after core protocol is working.

---

## IDENTITY MODEL

### Registry Record (the only thing Registry stores per user)
```
fingerprint     TEXT PRIMARY KEY   sha256 hash of current public key
public_key      TEXT               current RSA public key in PEM format
user_tag        TEXT UNIQUE        @handle, unique within this registry
display_name    TEXT NULLABLE      optional, user-chosen, not unique
registered_at   TIMESTAMP          original registration date, persists through rotations
```

### Private Recovery Table (NEVER exposed via any API, ever)
```
fingerprint     TEXT PRIMARY KEY   foreign key to registry record
email_hash      TEXT               sha256 of user-provided email, self-reported, never verified
```

### Nonce Table (temporary, used during challenge flows)
```
nonce           TEXT PRIMARY KEY
fingerprint     TEXT
expires_at      TIMESTAMP
```
Nonces are deleted immediately after use. Expired nonces are purged on read.

### Key States
A key either EXISTS in the registry (active) or it DOES NOT (revoked or rotated away from).
There is no status field. There is no history. A 404 on key lookup means the key is gone.
The reason it is gone (revoked vs rotated) is intentionally indistinguishable.

### Multi-Registry Identity Model
A single RSA keypair can be registered on multiple registries simultaneously.
Each registry is an independent identity namespace. The same keypair can have
different handles on different registries.

```
SAME KEYPAIR, MULTIPLE REGISTRIES:
  @alice@registry.sigil.local        ← handle on registry A
  @ali@orbit.example.com             ← different handle on registry B (alice was taken)
  @alice@relay.example.com           ← same handle on registry C (was available)

All three identities share the same RSA keypair.
A UNT stake specifies which registry endorsed it via the "iss" field.
Recipients verify the stake against that specific registry's public key.
```

ADDING A NEW REGISTRY — CLIENT FLOW:
```
1. User enters registry URL in settings
2. Client fetches GET {registry}/registry/public-key
   → confirms registry is reachable, caches its public key
3. Client checks GET {registry}/handle/@preferredhandle
   → 404: handle available, pre-fill with preferred handle
   → 200: handle taken, prompt user to choose alternative
4. User confirms or edits handle
5. Client runs full registration flow on new registry
   (challenge → register with keypair + chosen handle + email_hash)
6. New registry added to client's registry list with chosen handle

RESULT: User has identities on multiple registries.
        They select which registry to use as stake provider before sending each note.
        The stake's "iss" field tells recipients which registry endorsed it.
        Recipients must trust that registry's public key to verify the stake.
```

STAKE PROVIDER SELECTION:
```
Before composing a note, the client selects the active stake provider.
This determines which registry issues the stake for that note.
The selected registry is shown in the composer UI.
Different notes from the same user can be staked by different registries.
This is visible to recipients via the stake's "iss" field.
```

---

## THE UNIFIED NOTE TOKEN (UNT)

A UNT is the single unit of data in this protocol. It is a nested JWT.
Everything needed to verify a UNT is contained within it. No network calls required.

### Structure

#### OUTER JWT — signed by author's RSA private key (RS256)
```
HEADER:
{
  "alg": "RS256",
  "typ": "JWT"
}

PAYLOAD:
{
  "jti":       "<uuid v4>",             REQUIRED. Unique ID. Used for deduplication and replay prevention.
  "iat":       <unix timestamp int>,    REQUIRED. When the note was signed by the author.
  "type":      "note",                  REQUIRED. Distinguishes notes from server commands.
  "content":   "<string>",              REQUIRED for notes. The note text.
  "channel":   "<string>",              REQUIRED. Channel name. Default is "*".
  "reply_to":  "<jti string> | null",   REQUIRED. jti of parent UNT if reply, else null.
  "stake":     "<inner JWT string>",    REQUIRED. The registry-signed stake (see below).
  "stake_iat": <unix timestamp int>     REQUIRED. Copy of stake.iat, bound into outer signature.
}

SIGNATURE: RS256 signature using author's RSA private key.
```

#### INNER JWT (STAKE) — signed by Registry's RSA private key (RS256)
```
HEADER:
{
  "alg": "RS256",
  "typ": "JWT"
}

PAYLOAD:
{
  "iss":          "<registry domain>",      REQUIRED. e.g. "registry.example.com"
  "jti":          "<uuid v4>",              REQUIRED. Unique stake ID.
  "iat":          <unix timestamp int>,     REQUIRED. When registry endorsed this key.
  "sub":          "sha256:<fingerprint>",   REQUIRED. Author's key fingerprint.
  "public_key":   "<RSA public key PEM>",   REQUIRED. Author's RSA public key.
  "user_tag":     "@handle",                REQUIRED. Author's handle.
  "display_name": "<string> | null"         OPTIONAL.
}

SIGNATURE: RS256 signature using Registry's RSA private key.
NO EXPIRY FIELD. The stake is a historical notarization, not an access token.
```

### Why No Expiry On The Stake
The stake is a notarization: "At time stake.iat, this public key was valid and registered."
This is a historical fact. It does not expire. The freshness score (see below) handles time sensitivity.

### Freshness Score
```
delta_t = outer.iat - stake.iat   (in seconds)

delta_t < 5s:          5 locks  EXCELLENT  — stake fetched immediately before signing
delta_t 5s–30s:        4 locks  STRONG     — normal network latency
delta_t 30s–3min:      3 locks  GOOD       — slight delay
delta_t 3min–30min:    2 locks  WEAK       — stake reused across notes
delta_t 30min–24h:     1 lock   POOR       — long-lived stake
delta_t > 24h:         0 locks  UNTRUSTED  — stake too old
```

Freshness is tamper-proof:
- stake.iat is inside inner JWT, signed by Registry. Cannot be altered.
- outer.iat and stake_iat are inside outer JWT, signed by author. Cannot be altered.
- Swapping a fresher stake into an old note breaks the outer signature.
- Swapping an older note into a fresh stake breaks the outer signature.

### UNT Verification Algorithm
Always run all steps. Never skip steps. Never trust a UNT that fails any step.

```
STEP 1: Decode outer JWT header and payload WITHOUT verifying signature yet.
        Extract the "stake" field (inner JWT string) from the payload.

STEP 2: Verify inner JWT (stake) using Registry public key (baked into client at install).
        If signature invalid → DROP. Stop.
        Extract public_key, user_tag, display_name, stake.iat from verified stake payload.

STEP 3: Verify outer JWT signature using the public_key extracted in Step 2.
        If signature invalid → DROP. Stop.
        The outer payload is now trusted.

STEP 4: Verify stake_iat in outer payload matches stake.iat from inner payload.
        If mismatch → DROP. Stop.
        Check outer.jti against local seen-list.
        If already seen → DROP (duplicate or replay). Stop.
        Compute delta_t = outer.iat - stake.iat. Record freshness score.
        Add outer.jti to local seen-list.

RESULT: UNT is valid. Store it. Display freshness score to user.
```

---

## SERVER COMMAND UNTs

Server commands use the same UNT structure as notes but with type = "server_command".
They must pass the same four-step verification before a broker or client acts on them.
Only registered users can issue server commands (they must have a valid stake).
This is enforced implicitly — without a registry-endorsed stake, the UNT fails Step 2.

### subscribe
```
OUTER PAYLOAD:
{
  "jti":      "<uuid>",
  "iat":      <timestamp>,
  "type":     "server_command",
  "command":  "subscribe",
  "channels": ["channel1", "channel2"],
  "stake":    "<stake JWT>",
  "stake_iat": <timestamp>
}
Sent by client to broker on connect and whenever subscriptions change.
Broker updates its in-memory subscription map for this connection.
```

### unsubscribe
```
OUTER PAYLOAD:
{
  "jti":      "<uuid>",
  "iat":      <timestamp>,
  "type":     "server_command",
  "command":  "unsubscribe",
  "channels": ["channel1"],
  "stake":    "<stake JWT>",
  "stake_iat": <timestamp>
}
```

### request_notes
```
OUTER PAYLOAD:
{
  "jti":      "<uuid>",
  "iat":      <timestamp>,
  "type":     "server_command",
  "command":  "request_notes",
  "filters": {
    "channels": ["channel1"] | null,       null means no channel filter
    "author":   "sha256:fingerprint" | null,
    "since":    <unix timestamp> | null,
    "limit":    <int, max 100>
  },
  "stake":    "<stake JWT>",
  "stake_iat": <timestamp>
}
```

### note_response
```
OUTER PAYLOAD:
{
  "jti":          "<uuid>",
  "iat":          <timestamp>,
  "type":         "server_command",
  "command":      "note_response",
  "request_jti":  "<jti of the request_notes UNT this responds to>",
  "notes":        ["<UNT string>", "<UNT string>", ...],
  "stake":        "<stake JWT>",
  "stake_iat":    <timestamp>
}
Sent by a peer client back through the broker to the requesting client.
Each UNT in notes array must be independently verified by the recipient.
```

### revoke_key
```
OUTER PAYLOAD:
{
  "jti":         "<uuid>",
  "iat":         <timestamp>,
  "type":        "server_command",
  "command":     "revoke_key",
  "fingerprint": "sha256:<fingerprint of revoked key>",
  "stake":       "<stake JWT>",   ← this will be the NEW key's stake if key was rotated
  "stake_iat":   <timestamp>
}
Broadcast by client after successful revocation or rotation.
Broker fans out to all connected clients.
Clients cache the revoked fingerprint locally.
Future UNTs from revoked fingerprint are rejected at Step 2.
```

---

## NEW CLIENT ONBOARDING FLOW

```
STEP 1 — CONNECT AND SUBSCRIBE:
  Client opens WebSocket or SSE connection to Broker.
  Client immediately sends a subscribe server command UNT declaring channel interests.
  Broker registers client as listener. Client will now receive all future UNTs on those channels.

STEP 2 — REQUEST HISTORY:
  Client constructs and sends a request_notes server command UNT.
  Filters can specify channels, author, since timestamp, and limit.
  No filters = request recent notes from default channel.

STEP 3 — BROKER SELECTS PEERS:
  Broker verifies the request_notes UNT (four steps).
  Broker selects log(N) random currently connected clients as peers.
    N = total number of currently connected clients.
    Example: 1000 clients connected → ask ~10 peers.
  Broker forwards the original request_notes UNT to each selected peer.

STEP 4 — PEERS RESPOND:
  Each peer receives the forwarded request_notes UNT.
  Peer verifies the UNT (confirms requester is legitimate).
  Peer filters its local storage according to the filters in the command.
  Peer constructs and signs a note_response server command UNT.
  Peer sends note_response to Broker.

STEP 5 — BROKER ROUTES RESPONSES:
  Broker receives note_response UNT from peer.
  Broker verifies it.
  Broker reads request_jti → identifies which client made that request.
  Broker forwards note_response to that specific requesting client only.

STEP 6 — CLIENT PROCESSES HISTORY:
  Client receives note_response UNT.
  Client verifies the outer signature (peer who responded).
  Client iterates notes array.
  For each UNT: run full four-step verification independently.
  Deduplicate by jti (multiple peers return overlapping notes — this is expected).
  Store valid UNTs locally. Drop invalid ones silently.

FALLBACK — NO PEERS CONNECTED:
  Client receives no history. This is acceptable.
  Client will receive all future notes in real time from this point forward.
  Bootstrap Server (future scope) addresses this by acting as a always-on peer.
```

---

## CHANNELS

- A channel is a string of alphanumeric words separated by commas. Example: "news,tech"
- Channels are broker-local. Same name on two brokers = two independent channels.
- Channels are implicit. They come into existence when a note is pushed to them.
- No channel registration. No channel records stored anywhere.
- Default channel: "*" — used when no channel is specified in a UNT.
- Subscription matching: exact string match only. No wildcards. No partial matches.
- A client can subscribe to multiple channels simultaneously.
- Broker only relays a UNT to clients subscribed to that exact channel string.

---

## REGISTRY API

All state-mutating operations require a Registry-issued nonce challenge first.
Nonces are generated by Registry, not by client. Single use. Expire in 60 seconds.

### CHALLENGE FLOW (prerequisite for registration, stake issuance, rotation, revocation path A)
```
REQUEST:
  POST /challenge
  { "fingerprint": "sha256:..." }

RESPONSE:
  { "nonce": "<uuid generated by registry>", "expires_at": "<ISO timestamp>" }

Registry stores nonce temporarily associated with that fingerprint.
Client signs the nonce with their private key.
Client submits signed nonce with the subsequent operation request.
Registry verifies: nonce exists, not expired, signature valid against stored public key.
Registry deletes nonce immediately after verification regardless of outcome.
```

### 1. REGISTRATION
```
REQUEST:
  POST /register
  {
    "public_key":    "<RSA public key PEM>",
    "user_tag":      "@handle",
    "display_name":  "<string> | null",
    "email_hash":    "sha256:<hash>",     self-reported, never verified, stored privately
    "signed_nonce":  "<nonce signed with the private key matching submitted public_key>"
  }

RESPONSE (success):
  { "fingerprint": "sha256:...", "registered_at": "<ISO timestamp>" }

RESPONSE (user_tag taken):
  409 Conflict

RULES:
  user_tag must be unique. Reject if taken.
  Registry verifies signed_nonce proves ownership of submitted public_key.
  email_hash stored in private recovery table only. Never returned anywhere.
```

### 2. STAKE ISSUANCE
```
REQUEST:
  POST /stake
  {
    "fingerprint":  "sha256:...",
    "signed_nonce": "<nonce signed with private key>"
  }

RESPONSE:
  "<signed inner JWT stake string>"

Registry verifies signed_nonce, issues fresh stake JWT signed with Registry's own private key.
Client embeds this stake in UNTs as the inner JWT.
```

### 3. KEY LOOKUP
```
REQUEST:
  GET /key/{fingerprint}

RESPONSE (found):
  {
    "fingerprint":   "sha256:...",
    "public_key":    "<RSA public key PEM>",
    "user_tag":      "@handle",
    "display_name":  "<string> | null",
    "registered_at": "<ISO timestamp>"
  }

RESPONSE (not found):
  404

NOTE: 404 means the key does not exist. This covers: never registered, revoked, or rotated away from.
These cases are intentionally indistinguishable.
email_hash is NEVER included in any response. Ever.
```

### 4. HANDLE AVAILABILITY CHECK
```
REQUEST:
  GET /handle/{user_tag}

RESPONSE (available):
  404

RESPONSE (taken):
  200 { "user_tag": "@handle", "registered_at": "<ISO timestamp>" }

NOTE: Returns minimal info intentionally. No fingerprint, no public key exposed.
Only confirms whether a handle exists. Used by clients before registering on a
new registry to check if their preferred handle is available.
404 = available. 200 = taken.
```

### 5. KEY ROTATION
```
Registry issues TWO nonces simultaneously when rotation is initiated.

INITIATE:
  POST /rotate/challenge
  { "fingerprint": "sha256:old-fingerprint" }

RESPONSE:
  {
    "old_key_nonce": "<uuid>",
    "new_key_nonce": "<uuid>",
    "expires_at":    "<ISO timestamp>"
  }

COMPLETE:
  POST /rotate
  {
    "old_fingerprint":  "sha256:old...",
    "old_signed_nonce": "<old_key_nonce signed with OLD private key>",
    "new_public_key":   "<new RSA public key PEM>",
    "new_signed_nonce": "<new_key_nonce signed with NEW private key>",
    "email_hash":       "sha256:..." | null    only if changing email hash
  }

Registry verifies both signatures atomically. Both must pass. Partial success = full rejection.

RESULT:
  Old record deleted entirely.
  New record created with:
    fingerprint:   sha256 of new public key
    public_key:    new public key
    user_tag:      SAME as before (persists)
    display_name:  SAME as before (persists)
    registered_at: SAME as before (persists, reflects original registration)
  Private table updated with new fingerprint → same or new email_hash.
```

### 6. KEY REVOCATION — PATH A (KEY INTACT)
```
REQUEST:
  POST /revoke
  {
    "fingerprint":  "sha256:...",
    "signed_nonce": "<nonce signed with private key>"
  }

Registry verifies signature. Deletes record entirely. No trace left.
```

### 7. KEY REVOCATION — PATH B (KEY COMPROMISED, PRIVATE KEY LOST OR STOLEN)
```
STEP 1 — Prove knowledge of email:
  POST /revoke/email-init
  {
    "fingerprint": "sha256:...",
    "email":       "<plaintext email address>"    ONLY time plaintext email is ever sent to registry
  }

  Registry hashes the provided email using same algorithm as stored hash.
  Compares to stored email_hash in private table.
  If match: sends a one-time challenge link/OTP to that email address.
  If no match: returns identical 200 response. NEVER return an error distinguishing match from no-match.
  (Silent rejection protects against email enumeration attacks.)

STEP 2 — Prove ownership of email inbox:
  POST /revoke/email-confirm
  { "token": "<OTP or token from email>" }

  Registry verifies token. Deletes record entirely. No trace left.

SECURITY MODEL:
  Attacker needs BOTH simultaneously:
    Factor 1 (Knowledge): the plaintext email address
    Factor 2 (Possession): access to that email inbox
  A leaked database alone is insufficient. Hash cannot be reversed.
```

---

## TRUST ANALYSIS

### What Brokers CANNOT do
- Forge a UNT (no user private key)
- Modify note content (outer signature breaks)
- Forge a stake (no registry private key)
- Impersonate any user or the registry

### What Brokers CAN do
- Censor by refusing to relay specific UNTs
- Observe metadata: who posts, when, to which channels
- Mitigation: clients connect to multiple brokers simultaneously

### What Registry CANNOT do
- Read note content (notes never pass through registry)
- Reveal plaintext emails (only hashes stored, never returned)
- Forge a UNT (no user private key)

### What Registry CAN do
- Issue fraudulent stakes (registry is partially trusted)
- Refuse stake issuance (denial of service)
- Mitigation: clients pin registry public key at install; cannot be silently swapped

### What No One Can Do
- Alter a UNT in transit (both signatures break)
- Replay an old UNT (jti seen-list on every client)
- Use a stake from a different author (outer signature binds stake to note)
- Fake freshness score (both iat values are independently signed)

---

## FEDERATION

- Anyone can run a Broker. No permission or registration required.
- Brokers do not communicate with each other.
- Clients bridge brokers by connecting to multiple simultaneously.
- Author chooses which brokers to publish to at time of writing.
- Same channel name on two brokers = two independent partitions. This is by design.
- Cross-posting (future scope): republish an existing UNT to a different broker
  by wrapping it in a new outer signature. Original authorship preserved in inner stake.

---

## PLANNED FUTURE FEATURES (OUT OF CURRENT SCOPE — DO NOT IMPLEMENT NOW)

1. BOOTSTRAP SERVER
   A server behaving as a client. Subscribes to "*" only. Keeps up to 10MB of recent
   valid UNTs in memory. Responds to request_notes like a normal client.
   Ensures history availability when no peers are online.

2. PRIVATE CHANNELS (MLS — RFC 9420)
   Group encryption with forward secrecy and post-compromise security.
   Registry manages ratchet tree state. Broker unchanged.

3. PRIVATE DIRECT MESSAGES
   JWE encryption of content with recipient's public key. Two-party only.

4. CROSS-POSTING ATTRIBUTION
   Formal wrapper format for republishing another user's UNT to a new broker.

5. CHANNEL DISCOVERY
   Mechanism for clients to discover available channels on a broker.

6. BROKER DISCOVERY
   Mechanism for clients to find available brokers for a given registry network.

7. SPAM PREVENTION
   Anonymous identity means no cost to flooding. Solution TBD.

8. CLIENT-SIDE KEY PINNING
   Cache public keys after first fetch to detect registry key substitution over time.

---

## QUICK REFERENCE FOR IMPLEMENTATION

```
UNT             = nested JWT. Outer signed by author (RS256). Inner (stake) signed by Registry (RS256).
STAKE           = inner JWT. Registry's endorsement of a public key at a point in time. No expiry.
FRESHNESS       = delta_t = outer.iat - stake.iat. Smaller = more secure. Display as lock icons.
CHANNEL         = alphanumeric comma-separated string. Default = "*". Broker-local. Exact match only.
FINGERPRINT     = sha256 hash of RSA public key. Primary identifier for a user.
USER TAG        = @handle. Unique per registry. Persists through key rotation.
NONCE           = generated by Registry. Single use. 60 second expiry. Prevents replay attacks.
JTI             = UUID on every UNT. Used for deduplication and replay prevention on every client.
404 on lookup   = key does not exist (covers: never registered, revoked, rotated away from).
email_hash      = self-reported sha256 of email. Private table only. Never in any API response.
Registry ↔ Broker = NO communication. Ever.
Private key     = never leaves client device. Ever.
Note storage    = clients only. No server stores notes. Ever.
```
