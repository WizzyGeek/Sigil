# Sigil — Decentralized Notes Protocol (DNP)

Sigil is a protocol and reference implementation for exchanging signed notes through brokers. Clients verify registry endorsements and author signatures independently of the broker.

**What the current implementation provides:**

- The client sends public keys and signatures to servers, not its private keys. Generated private PEMs are shown once for the user's own backup.
- Notes are signed, **not encrypted**. Brokers and recipients can read their content.
- The reference broker has no persistent note archive; clients retain verified notes in IndexedDB. Brokers still hold frames and routing/cache state in memory.
- Verification detects changes to signed payloads and proves possession of the endorsed signing key. Replay suppression depends on the receiving implementation and its retained JTI state.

Client, registry and broker are independently deployable roles, **not isolated services**. Clients call registries and brokers; brokers also contact registries to obtain verification keys. Optional endpoint discovery adds further service probes, described separately below.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [How It Works](#how-it-works)
   - [Identity and Registration](#identity-and-registration)
   - [UNT — Unified Note Token](#unt--unified-note-token)
   - [Freshness Score](#freshness-score)
   - [Publishing a Note](#publishing-a-note)
   - [Receiving and Verifying Notes](#receiving-and-verifying-notes)
   - [Multiple Brokers and the Timeline](#multiple-broker-connections-and-the-timeline)
   - [Requesting History](#requesting-history)
3. [Protocol Commands](#protocol-commands)
4. [Optional Implementation Extensions](#optional-implementation-extensions)
5. [Security Model](#security-model)
6. [Directory Structure](#directory-structure)
7. [Running the Stack](#running-the-stack)
8. [Configuration Reference](#configuration-reference)
9. [Development](#development)

---

## Architecture Overview

```mermaid
flowchart LR
    C["Client (browser)"] <-->|"WebSocket: signed notes and control frames"| B["Broker"]
    C -->|"HTTPS: challenges, registration, stakes, public keys"| R["Registry"]
    B -->|"HTTPS: issuer public-key lookup and refresh"| R
    R -->|"Persistent identity and service metadata"| P["PostgreSQL"]
```

| Role | Current responsibilities and storage |
|------|--------------------------------------|
| Client | Stores per-identity private-key copies and verified notes in IndexedDB; signs outgoing UNTs; verifies received notes; manages broker connections and peer history. |
| Registry | Stores public keys, unique handles, recovery-email hashes and challenges in PostgreSQL; issues stakes; supports rotation/revocation. The included discovery extension also stores verified endpoint advertisements and sweep scheduling metadata. |
| Broker | Obtains issuer keys from registries, verifies UNT envelopes, tracks subscriptions/connections, and routes broadcasts and replies. Its key cache, JTI/request-correlation cache and frame queues are in memory; it does not persist note history. |

For a previously unseen issuer, the broker fetches `https://<issuer>/registry/public-key` before validating its stake. It fetches again when its cached key expires. Explicit administrator mappings can point an issuer at a different key endpoint, including HTTP/private addresses for local development. This is a **public-key fetch**, not an exchange of private keys or an online registry lookup for each author's account. See [broker configuration](#broker-brokerenv).

The **note-relay graph** is bipartite: clients connect to brokers, with no direct broker-to-broker relay or client-to-client sockets. That describes note/control-frame transport, not every network request in the system. Registry identity APIs and broker-to-registry key retrieval sit outside that graph. The [discovery extension](#discovering-registries-and-brokers) additionally makes registry-to-registry HTTPS probes and registry-to-broker WebSocket probes.

The browser uses HTTPS registry endpoints in production and permits loopback HTTP for development. WebSocket endpoints may use `ws://` or `wss://`; the native broker/registry listeners use plain HTTP and need appropriate TLS termination for public HTTPS/WSS deployment. Compose provides local development routing.

Clients trust the configured registry's endorsement of a handle/key and the key retrieved for that issuer. They do not trust a broker to establish authorship. A malicious broker can read, copy, delay or drop plaintext notes, but cannot produce a valid signature for an existing author's key without that key.

---

## How It Works

### Identity and Registration

A saved identity associates a handle and registry with a signing key. Newly generated keys use RSA-4096; the client can also import existing RSA PKCS#8 keys, and the verifiers do not universally enforce a 4096-bit modulus. Whenever Sigil generates a key, it shows the PKCS#8 private PEM once and requires a backup acknowledgement before registration or rotation proceeds. The retained IndexedDB signing key is non-extractable. The PEM can be copied or downloaded while that screen is open; it is unencrypted and must be kept private.

**Fingerprint** — the canonical identifier for a keypair:

```
key_hash = hex(SHA-256(SPKI DER bytes of public key))
author_fingerprint = "sha256:" + key_hash
```

Registry API `fingerprint` fields and browser identity metadata use the bare 64-character `key_hash`. Note `authorFp` and history-routing fingerprints use the `sha256:`-prefixed form.

**Fully-qualified user identifier:**

```
@alice@registry.example.com
```

The `@alice` part is local to a registry. The database enforces one record per key fingerprint and a unique handle within that registry; multiple handles on one registry therefore need different keys. The protocol/backend can associate one key with different handles on different registries, for example:

```
@alice@registry.sigil.local
@ali@orbit.example.com
```

The client stores a separate key copy for each identity. Its current bulk-rotation workflow groups matching handle names across registries onto matching replacement key material, while different handle names receive separate replacements.

**Registration flow:**

1. Client generates keypair locally
2. Client requests a nonce (UUID challenge) from the registry
3. Client signs the nonce with its private key
4. Client submits public key + signed nonce + desired handle to registry
5. Registry verifies the signature, stores the public key and handle
6. Client is registered. The registry has the public key and proof of possession, not the client's private key. A malicious registry can still endorse a different key under a claimed handle; compare fingerprints as well as handles.

**Stake issuance** — used for publishing and signed control/history frames; a recently verified stake can be reused:

1. Client requests a fresh nonce
2. Client signs the nonce with its private key
3. Client sends the signed nonce to `POST /stake`
4. Registry issues a signed endorsement (the stake): `{ public_key, user_tag, display_name, iat, iss }`
5. Client reuses a cached stake while its signed `iat` is less than 25 seconds old
6. Client embeds the stake inside every UNT it signs

---

### UNT — Unified Note Token

A UNT is the signed wire unit for notes and control frames. It embeds the registry-signed stake and the author's public key, but **does not embed a trusted registry public key**. Once the verifier has the correct issuer key, both signatures can be checked locally without an author-account lookup. Acquiring or refreshing the issuer key may require a network request: the client loads keys from configured registries, and the broker fetches them by issuer.

**Wire format:** a two-element JSON array

```text
[ payload_object, "base64-encoded-signature" ]
```

The payload object is a raw JSON object (never base64-encoded). The signature uses RSA PKCS#1 v1.5 with SHA-256 over canonical JSON (recursively sorted keys, compact encoding, UTF-8, no HTML escaping, and escaped U+2028/U+2029). Newly generated client keys use 4096 bits.

**Outer payload** (signed by the author's private key):

```json
{
  "jti":       "550e8400-e29b-41d4-a716-446655440000",
  "iat":       1719532800,
  "type":      "note",
  "channel":   "news,tech",
  "content":   "Hello, decentralized world.",
  "reply_to":  null,
  "stake": [
    {
      "iss": "registry.example.com",
      "iat": 1719532795,
      "user_tag": "@alice",
      "display_name": "Alice",
      "public_key": "-----BEGIN PUBLIC KEY-----\n..."
    },
    "base64-stake-signature"
  ],
  "stake_iat": 1719532795
}
```

**Inner payload — the stake** (signed by the registry's private key):

```json
{
  "iss":          "registry.example.com",
  "iat":          1719532795,
  "user_tag":     "@alice",
  "display_name": "Alice",
  "public_key":   "-----BEGIN PUBLIC KEY-----\n..."
}
```

The outer signature covers the entire stake array. This means:

- You cannot swap in a different stake (outer signature breaks)
- You cannot modify note content (outer signature breaks)
- You cannot forge the stake (registry private key required)
- The additional `stake_iat` field must equal the signed stake's `iat`; a mismatch is rejected. The outer signature binds the actual stake bytes, including when two stakes have the same timestamp.

---

### Freshness Score

The freshness score (0–5) is computed from the note's declared issuance time and the registry's signed endorsement time. Both timestamp fields are covered by signatures; they cannot be edited in transit without invalidating a signature. This is not independent proof of the author's wall-clock signing time.

```
delta_t = outer.iat − stake.iat   (seconds)
```

| delta_t | Score | Label     | Meaning |
|---------|-------|-----------|---------|
| < 5s    | 5     | Excellent | Stake fetched immediately before signing |
| 5s ≤ delta < 30s | 4     | Strong    | Normal network latency |
| 30s ≤ delta < 3m | 3     | Good      | Slight delay |
| 3m ≤ delta < 30m | 2     | Weak      | Stake reused across notes |
| 30m ≤ delta < 24h | 1     | Poor      | Long-lived stake |
| ≥ 24h   | 0     | Lowest freshness | At least 24 hours between the declared times |

The current scoring function also maps negative deltas to 5 because they satisfy `< 5`; it does not itself enforce that the stake predates the note. Client verification and broker forwarding policy are separate from this calculation.

The client shows the exact endorsement age at signing as a duration on each note (for example, `12s` or `2m 10s`). Hover, focus, or tap a note’s handle beside its display name to see the full SHA-256 fingerprint, issued-at time with timezone/UTC timestamp, and exact freshness duration. This measures `note.iat − stake.iat`, not how long ago the note arrived. This broker applies the configured minimum freshness threshold as a forwarding policy and drops frames below it.

---

### Publishing a Note

1. Client obtains a stake from the chosen identity's registry or reuses one less than 25 seconds old
2. Client constructs the outer payload with the stake embedded
3. Client signs the outer payload with its private key using Web Crypto
4. Client sends the resulting UNT over its WebSocket connection to the broker
5. Broker obtains the issuer key if needed, verifies the envelope, applies its configured forwarding rules, then fans out the original frame to channel subscribers other than the sender. Full queues can drop deliveries.

The reference broker relays the received frame bytes unchanged. Signatures cover canonical payload JSON, not the original wire whitespace or the entire `[payload, signature]` array.

---

### Receiving and Verifying Notes

The reference client verifies every note it accepts for storage/display. It also checks history/control envelopes it processes and independently verifies each original note inside a history reply. The reference broker verifies outer envelopes; it does not individually verify every original inside `note_relay`.

Note acceptance follows this flow:

```
Step 1 — Parse
  Extract [outer_payload, outer_sig] from the frame
  Extract stake = outer_payload.stake = [stake_payload, stake_sig]

Step 2 — Verify registry-signed stake frame
  Select the configured key bound to stake_payload.iss
  If no issuer-bound key is available → DROP. Stop.
  Verify stake_sig using that registry public key
  If this fails → DROP. Stop.
  Extract: public_key, user_tag, display_name, iat from verified stake_payload

Step 3 — Verify author-signed outer frame
  Verify outer_sig using public_key from the verified stake
  If this fails → DROP. Stop.

Step 4 — Apply invariants
  Check outer_payload.stake_iat == stake_payload.iat
  Check note claim types and the stake_iat binding
  Compute freshness from (outer.iat − stake.iat)
  Atomically insert by JTI in IndexedDB; an existing JTI is not inserted again
  Display accepted notes; skip unverifiable originals in history batches
```

The implementation is in [`client/src/crypto/registryTrust.ts`](client/src/crypto/registryTrust.ts), [`client/src/crypto/unt.ts`](client/src/crypto/unt.ts), and [`broker/internal/protocol/unt.go`](broker/internal/protocol/unt.go).

Successful verification shows that the selected registry key signed the embedded endorsement and the corresponding author key signed the outer payload, including its declared `iat`, JTI and content. It does not independently prove those timestamps reflect real-world events. JTI uniqueness is a local storage/forwarding policy, not a property supplied by RSA signatures.

---

### Multiple broker connections and the timeline

The note-relay connections are **bipartite**: clients connect to brokers; brokers do not relay directly to each other, and clients do not open direct peer sockets. Brokers also make registry HTTP requests for issuer keys, outside this relay graph.

The landing page is a static, text-led introduction to identity ownership, signed notes and the client/registry/broker roles, with no canvas or decorative animation. It remains accessible at `/` with a saved identity; its main actions become **Go to app** instead of starting onboarding. Identity restoration completes before those actions become available. `/app` still requires an active identity. GitHub and README links point to the source repository; `VITE_REPOSITORY_URL` can override that destination for a fork.

The app uses a wider channel rail, a centered notes timeline and a composer aligned with the notes. On narrow screens, channels become a horizontally scrolling row. **Enter** sends a note; **Shift + Enter** adds a new line. The composer shows the UTF-8 byte count against the configured limit. The identity menu groups rotation, verification-key refresh and bulk deletion under **Key management**; each identity keeps its own local-delete and revocation actions. Broker controls remain beside the composer, with separate R (read) and P (publish) permissions.

The **top identity menu** selects a saved handle and its key, rather than selecting a server. **Add identity** creates a separate key/handle or imports an existing registered PKCS#8 PEM key. Multiple handles on the same registry use independent keys, matching the registry’s one-handle-per-key model. Creating or importing another identity preserves all previously saved keys. Each saved handle/registry identity owns a separate stored key copy, including identities with identical key material and fingerprints. Deleting one copy does not affect another. Legacy single-key and per-fingerprint records migrate automatically to per-identity copies. Switching resets broker/history sessions and shows the selected signing identity above the composer; unsent drafts stay separate per identity in the current tab.

The **bottom broker menu** adds/removes WebSocket URLs and has independent **R** (read) and **P** (publish) checkboxes for each broker:

| R | P | Behavior |
|---|---|----------|
| on | on | Connect, subscribe/request history, receive notes, publish authored notes and answer history requests. |
| on | off | Connect and read/request history; never send authored notes or history replies. |
| off | on | Connect and publish authored notes, without subscriptions, history requests or incoming delivery. |
| off | off | Keep the configured URL but close its socket. |

Every connection has independent status and reconnection behavior. URL lists and R/P choices are saved per key; older settings default to both enabled. A newly added key starts with the current broker/channel choices. These preferences are currently indexed by fingerprint, so identities with the same fingerprint share them even though their private-key records are separate. Removing one broker leaves the others connected.

Newly authored notes are signed **once** and published with the **same JTI** to each connected broker with **P** enabled. Received notes are verified and saved locally; **they are never automatically forwarded to another broker**. A note learned on broker 1 becomes available on broker 2 only when a broker-2 peer requests history and this client has **R + P** enabled to respond through broker 2. History requests, replies, pagination and request correlation are kept on their respective broker connection.

The client combines local notes, live arrivals and history from all broker connections into one timeline, deduplicated globally by JTI and sorted by signed `iat` (then JTI for stable same-second ordering). Signature and registry-issuer checks apply before an incoming note can enter that shared cache. Replies show the original author, a two-line excerpt and its issue time when the referenced JTI is present in the verified channel timeline. Clicking the preview jumps to and focuses the original. Missing originals show an explicit placeholder and **Fetch original**, which sends a signed `request_note` for that exact JTI to readable broker connections. This lookup does not scan channel history. Previews update when a verified original arrives; an offline peer or missing archive can leave it unavailable.

Initial channel loads follow the latest note, and new notes continue to scroll down while the reader is near the bottom. Scrolling up pauses automatic following; **Latest note** returns to the bottom. Sending a note also moves to the latest position.

### Requesting One Note

A reply is an ordinary signed `note` whose `reply_to` field names the parent note's JTI; it does not embed or quote the parent. If that parent is not already in the verified local timeline, **Fetch original** uses `request_note` to ask peers for that exact JTI. This is separate from `request_notes`, which pages a peer's available channel history.

`request_note` is a direct lookup extension. Its signed payload includes the normal `jti`, `iat`, `channel`, `stake` and `stake_iat`, plus `note_jti` identifying the original (a nonempty string of at most 256 UTF-8 bytes). It has no history cursor or pagination. Brokers verify it, apply the shared five-minute admission window and global JTI deduplication, record its originating connection, and fan it out to other subscribers in the named channel.

A peer with R + P enabled looks up that JTI directly in its local database and verifies the stored original. If its JTI and channel match, the peer sends a signed `note_relay` with `to`, `request_jti`, `note_jti` and exactly one original in `relays`. Peers without the note stay silent. The broker routes the reply to the exact requesting connection. The requester requires a live matching request, recipient, channel and target JTI, then independently verifies the original registry endorsement and author signature before saving or displaying it. A signed envelope alone does not authenticate an original.

Each broker connection coalesces concurrent lookups for the same channel/JTI, permits at most 64 pending lookups, and expires them after `VITE_HISTORY_TIMEOUT_MS`. There are no automatic retries; **Fetch original** lets the reader retry. Replies remain on the source broker and do not automatically bridge notes to other brokers. Older brokers and clients may ignore this extension; a timeout does not prove that the original never existed.

### Requesting History

Brokers store no notes. A client subscribes to its joined channels on each connected broker with **R** enabled and independently requests history for the active channel after connecting, reconnecting, or switching channels. **Refresh history** restarts the exchange manually.

1. The requester sends a fresh, signed `request_notes` with a snapshot boundary `till`. The initial boundary includes notes from the current second.
2. The broker fans the request out to other subscribers in that channel. In this client, a peer with **R + P** enabled can respond, including a sole other peer; there is no peer-selection sampling. Responses and delivery are still best effort.
3. Each peer reads a page from its local IndexedDB, verifies the original notes, and sends a signed `note_relay`. The reply contains `to` (requester fingerprint), `request_jti` (the original request), and `peer_id` (the responder's session ID).
4. The broker uses the request JTI to route the response to the exact requesting connection, including when several tabs/devices share a fingerprint. This correlation metadata shares the bounded broadcast JTI cache: it is valid for at most five minutes and can be evicted earlier under capacity pressure. It stores no notes.
5. The requester checks the envelope, recipient, outstanding request, channel, issuer-specific signatures, and each original note. Individual originals that fail verification or use an untrusted registry are skipped, counted in the UI, and never saved; the authenticated page cursor still permits fetching older trusted notes. An atomic IndexedDB transaction saves each JTI once, even when live traffic and several peers supply it concurrently.
6. Replies include `has_more` and `next_cursor: {iat, jti}`. The requester pages each responding session independently, sending fresh request JTIs and targeting that peer's fingerprint and `peer_id`. The compound cursor prevents losing notes sharing a timestamp and prevents one peer's cursor from skipping another peer's history.
7. Pages respect both the configured batch count and the serialized frame byte limit. Fresh relay envelopes can carry original notes older than the broker's five-minute broadcast cutoff. Empty replies acknowledge a peer with no matching notes.

Requests that receive no reply retry up to three times, always with a **new JTI** so broker deduplication does not swallow retries. The default reply/peer-discovery window is five seconds per attempt. The UI reports received-note progress, broker history status, skipped unverified entries, no replies, or incomplete transfers. It cannot enumerate peers that never responded or prove that all network history was fetched. Reconnecting restarts synchronization, and **Refresh history** retries a partial transfer without duplicating stored notes.

History is limited to what connected peers retain and which registry keys the requester trusts. Offline peers cannot supply data; peers using the previous one-page protocol need the updated client. No centralized archive or listener is required. IndexedDB version 2 adds a history pagination index while preserving version-1 notes; other open tabs running old code may need a reload to allow the database upgrade.

---

## Protocol Commands

All frames — including control frames — are UNTs. The `type` field in the outer payload determines routing.

| Type | Direction | Description |
|------|-----------|-------------|
| `note` | client → broker → subscribers | A signed note |
| `subscribe` | client → broker | Register interest in a channel |
| `unsubscribe` | client → broker | Remove channel subscription |
| `request_notes` | client → broker → peers | Request stored notes from peers |
| `request_note` | client → broker → peers | Fetch one original by `note_jti`; correlated by the request's `jti` |
| `note_relay` | peer → broker → requester | Returns history pages for `request_notes`, or one original in `relays` for `request_note`; both use `request_jti` correlation |

**Channels** are plain strings (e.g. `"news,tech"`). They are broker-local, implicit (no registration needed), and matched by exact string equality. There is no special wildcard subscription. The client suggests `VITE_DEFAULT_CHANNELS` when configured; otherwise users join channels explicitly.

---

## Optional Implementation Extensions

The following are implementation choices rather than requirements of the signed UNT wire format. They are included in this repository; **optional at the protocol level does not mean each currently has an on/off setting**.

| Extension | Owner | Status in this source tree |
|-----------|-------|----------------------------|
| Registry-key cache and failed-fetch backoff | Broker | Always used by the broker entry point. Capacity is fixed at 10,000; successful-key TTL is configurable. Key acquisition and correct issuer binding remain necessary even if another broker uses a different cache strategy. |
| Broadcast JTI deduplication, age cutoff and request-correlation state | Broker | Always enabled in this broker: fixed 100,000-entry LRU and five-minute broadcast cutoff. There is no disable flag. The current history reply router also uses this cache to identify the requesting connection; another implementation needs equivalent correlation if it supports that routing behavior. |
| Endpoint advertisements, recommendations and sampled health sweeps | Registry + client | A discovery convenience, not required to sign, route or verify notes. This registry includes discovery routes/storage; this client automatically queues eligible URLs. Only the periodic sweep has a disable setting (`DISCOVERY_RECHECK_INTERVAL_SECONDS=0`), which does not disable admission, sharing or suggestions. Manual endpoint entry works without discovery support. |

### Broker registry-key cache

Source: [`broker/internal/registry/cache.go`](broker/internal/registry/cache.go), [`fetcher.go`](broker/internal/registry/fetcher.go), and [`cmd/broker/main.go`](broker/cmd/broker/main.go). The cache reduces repeated broker-to-registry requests; it does not eliminate that communication.

The registry cache holds up to **10,000** records, including unsuccessful lookups. A missing issuer whose fetch fails gets a **55-second** retry delay. A failed refresh of an expired record uses **1.5 × its previous TTR**. Cached failures suppress network retries until expiry; expired keys are never used. Successful fetches reset the lifetime to `REGISTRY_KEY_TTL_SECONDS` (default five minutes). Expired records retain retry history until refreshed or evicted. When full, the earliest-expiring record is evicted only if it expires strictly before the new record; otherwise the fetched result is used for the current frame without being cached. Concurrent lookups for one issuer share a fetch, and slow registries do not block the central routing loop.

### Broker broadcast deduplication and forwarding policy

Source: [`broker/internal/hub/hub.go`](broker/internal/hub/hub.go) and [`jti_cache.go`](broker/internal/hub/jti_cache.go).

For verified `note`, `request_notes` and `request_note` broadcasts, the broker drops frames older than **five minutes** before accessing the JTI cache. Recent frames share a **global, 100,000-entry LRU JTI cache** across these message types, channels, and authors. A duplicate refreshes its recency but is never forwarded again while cached. At capacity, eviction removes the least recently observed JTI. With LRU eviction, alternating two recent JTIs keeps them present and suppressed; introducing enough other unique JTIs can still evict them. Invalid signatures, missing JTIs, stale frames, and oversized note content cannot reserve cache entries. Other control types and history relay contents do not use this broadcast deduplication cache.

Cache contents are process-local and lost on restart. A JTI can be replayed after eviction/restart if other admission rules still allow it. The five-minute cutoff is based on the author's signed `iat`; it does not attest to a real signing time or impose a future-timestamp check. This is replay suppression, not a rate limit for new valid JTIs. The client's IndexedDB JTI uniqueness is a separate local mechanism.

### Discovering registries and brokers

Registries keep a public directory of unique registry and broker endpoint URLs. Signed-in clients automatically advertise newly added endpoints, as well as their known configured endpoints, to the active identity’s registry. Adding an identity on another registry also queues its URL for the registry that was active before the switch. Sharing is automatic; it does not send private keys, handles, channel memberships or note contents. Broker URLs with query strings are excluded so connection tokens are not made public. Localhost and obvious private-address endpoints are also excluded by the client; the registry independently checks every submitted candidate.

Registry and broker URL fields show advertised suggestions ranked by exact match, prefix, substring and typo similarity. Select with a click or arrow keys and Enter. Suggestions come only from the **current identity’s registry**; onboarding uses the configured **`VITE_REGISTRY_URL` default**. Without a source registry, discovery makes no requests and manual entry remains available. An offline or older registry leaves manual entry working. Selecting a suggestion fills the field; it never connects, registers an identity or trusts a new registry automatically. Accepted advertisements passed a public-reachability and service check when advertised; they are not endorsements or an ongoing availability guarantee. Registry trust still requires the normal issuer/key checks.

- `GET /discovery?kind=registry|broker&query=…&limit=8` returns up to 20 `{kind, url}` entries. Reads are public, including during onboarding.
- `POST /discovery/advertise` accepts `{fingerprint, nonce, registries, brokers, signature}` from an identity registered on that registry. The signature covers canonical JSON of the other four fields. A fresh challenge is consumed, then each candidate is checked before normalized `(kind, url)` records are upserted. Repeat advertisements do not create duplicates. Requests contain at most eight total endpoints and return `accepted` and `rejected` entries with rejection reasons.

Admission resolves all DNS answers and rejects non-global addresses, mixed public/private answers, localhost, private/loopback/link-local/reserved ranges, IPv4-mapped/tunnel IPv6 addresses and internal host suffixes. Probes connect to a checked numeric IP while retaining the original HTTP Host and TLS SNI/certificate hostname, so a second DNS lookup cannot rebind the connection. Registry probes require HTTPS with valid TLS and a bounded `/registry/public-key` JSON response containing an RSA public key; broker probes require a valid WebSocket upgrade, including its accept hash, with valid TLS for `wss://`. Redirects are not followed. DNS, queueing, connection and response share a four-second deadline, with at most eight probes running per process. Header/body sizes are bounded. A failed recheck removes an older matching advertisement. Only verified rows are served, and migration removes advertisements recorded before verification existed.

The client persists an advertisement outbox, coalesces duplicate URLs and retries temporary verification/network failures after 30 seconds without blocking identity/broker additions. Unsupported discovery endpoints, revoked identities and permanently non-public candidates are dropped from the queue. A failed candidate does not prevent other candidates from being advertised. Directory records remain when a client removes an endpoint locally. The registry creates the directory table/index idempotently on startup, including existing database volumes; the database role must be able to create them. Periodic sweep settings are listed below.

Every six hours, an async registry task checks a **uniform random sample of up to 20 advertisements** (or all available entries when fewer exist). Healthy entries get a fresh verification timestamp; failed entries are deleted. The task reuses admission’s DNS/IP, TLS, protocol, timeout and size checks. Sampling is probabilistic: an offline entry can remain until a future sweep selects it. PostgreSQL stores the schedule and an expiring lease, so workers/replicas sharing the database do not each run a duplicate sweep. The task checks for due work at startup and once a minute; restarts retain the schedule, failures retry after a minute, and shutdown cancels the task before closing the database pool. A failed old sample cannot delete a newer successfully verified advertisement.

Set `DISCOVERY_RECHECK_INTERVAL_SECONDS` (default `21600`, six hours; `86400` for daily; `0` to disable) and `DISCOVERY_RECHECK_SAMPLE_SIZE` (default `20`, range `1`–`1000`) on the registry. Neither setting changes the immediate admission checks.

---

## Security Model

### Signature guarantees and trust boundaries

Without the corresponding private key, a broker or third party cannot create a valid author signature or registry signature. Modifying a signed payload makes its signature fail. Copying and replaying an intact signed frame does **not** require breaking cryptography; suppression is described in the [implementation extensions](#optional-implementation-extensions).

A verified note proves possession of the author key endorsed by the selected registry, not a real-world person's identity or an independently measured signing time. A registry controls its own endorsements and can endorse an attacker's key under a claimed handle. Comparing full fingerprints distinguishes different keys, but cannot make a malicious registry trustworthy.

### What each role can observe or change

- **Broker:** sees plaintext note contents, handles/stakes, channels, timing and connection metadata. It can retain copies, censor, drop, delay or replay traffic. The reference implementation has no persistent note archive, but that is not a guarantee about other operators. Multiple brokers offer alternate paths, not guaranteed delivery or confidentiality.
- **Registry:** normally receives identity/challenge/stake/rotation/revocation requests rather than note bodies. It knows the registered public key, handle and optional display name/recovery-email hash. Its own private key lets it issue arbitrary endorsements, but not sign for an existing user's private key. Discovery additionally exposes advertised endpoint URLs and causes outbound health probes; those probes do not carry note bodies.
- **Client:** trusts issuer keys fetched from its configured registries and rejects notes whose issuer key is missing or whose signatures/binding fail. It checks each original in history independently. HTTPS/TLS validation protects key retrieval in transit; this client does not bundle or permanently pin registry keys at build time.

Notes have no content encryption. Recovery email is submitted as a normalized SHA-256 hash, not plaintext; this does not guarantee that a guessable email address cannot be recovered by guessing hashes. Registry email delivery remains a development stub.

### Key generation, backup, and rotation

Every generated identity key uses the same **Back up your private key** screen: onboarding, adding a handle, and rotating one or many identities. Copy or download the unencrypted PKCS#8 PEM, then acknowledge that it has been saved. **Use this key** is disabled until acknowledgement. Sigil retains only a non-extractable signing key; the PEM is not stored in IndexedDB or local storage and cannot be shown again. Cancelling before acknowledgement changes no registrations. Existing imported PEMs do not trigger a new generated-key screen. A full encrypted identity/configuration package remains separate future work.

In the **top identity menu → Rotate identity key**, choose:

- **Only this registration**: update the selected handle at its registry; other registrations using the old key keep working.
- **Every registration using this key**: update all handles associated with the current key.
- **All saved identities**: update all registered identities in the local key collection.

Choose **Generate new keys** or **Import keys**. Replacements are grouped by the handle name before the registry suffix: `wiz@reg1` and `wiz@reg2` share one replacement PEM, while `wiz` and `wiz2` receive different keys. Import supplies a separate PKCS#8 PEM per handle group. Existing compatible keys can be imported to reunite a matching handle across registries. Different handles cannot accidentally be assigned the same imported key. Imported targets are checked before any registry changes.

Every old and replacement key signs the registry’s rotation nonce. Each registry replaces its record atomically, preserving the handle, display name, registration date and recovery-email hash, and clears outstanding old-key challenges. All replacement signing keys and a per-registration progress journal are persisted before the first rotation request. An interrupted transfer pauses sending; **Resume key rotation** reuses the saved replacements and skips successful registrations, without generating or showing new PEMs. Source keys stay available until every selected registration succeeds. Finalization preserves unselected registrations and unrelated keys, merges matching-handle registrations onto their new key, and atomically commits the active key and replacement collection. Startup migration and lifecycle operations share a browser Web Lock; other open tabs reload on lifecycle updates.

### Key revocation and local deletion

The top identity panel provides distinct actions:

- **Delete locally** beside an identity removes that identity and its own private-key copy from this client. Other identities, including copies with the same fingerprint, remain. No revocation or registration request is sent. The client switches to another saved identity, or returns to the landing page when none remain.
- **Delete all local keys** wipes every saved/staged key and unfinished rotation journal, along with local identity configurations and queued advertisements. It is also available on the landing/onboarding screens when key material remains before sign-in. Confirmations warn that PEM backups are required to restore access and unfinished rotations will be discarded. Registry registrations and stored note history remain intact.
- **Revoke** signs a fresh registry challenge and calls `POST /revoke` with `{ fingerprint, nonce, signature }`. It invalidates the remote registration and retains the local key copy until you explicitly delete it.
- **Revoke all and delete local key** revokes all configured registrations using the selected fingerprint, then deletes those local key copies. Other fingerprints remain available. Each successful remote revocation is saved durably; a failure retains the remaining keys/configuration for retry.

Local deletion never calls revocation. Restore a locally deleted identity using its original PEM backup through **Import Identity**. Per-identity deletion is blocked during an unfinished rotation; an explicit all-keys wipe can discard it. Lifecycle updates refresh other open tabs, and onboarding checks that a key is still stored before activating it, so a stale tab cannot restore a deleted in-memory key. Sign out is not exposed in the identity menu; switching identities keeps their individual key copies available.

Revocation prevents future stakes from being issued for that registration. Previously issued stakes and signed historical notes are not retroactively invalidated by an online revocation list: brokers and peers verify them offline according to their existing age and signature rules.

Email recovery remains unfinished: `/revoke/email-init` accepts `recovery_email_hash` and returns a development debug token; it does not send email. `/revoke/email-confirm` consumes that token. No plaintext recovery email is sent by onboarding.

---

## Directory Structure

```
DNP/
├── broker/                       Go WebSocket message relay
│   ├── cmd/broker/main.go        Entry point — env config, startup
│   └── internal/
│       ├── hub/
│       │   ├── hub.go            Subscription map, fanout, unicast, routing
│       │   └── client.go         Per-connection read/write goroutines
│       ├── registry/             Issuer key fetching and bounded cache
│       └── protocol/
│           ├── unt.go            4-step UNT verification algorithm
│           └── commands.go       UNT type constants
│
├── registry/                     Python FastAPI identity provider
│   └── src/registry/
│       ├── main.py               App setup, CORS, router registration
│       ├── config.py             Pydantic settings (reads .env)
│       ├── db.py                 PostgreSQL connection pool (psycopg_pool)
│       ├── auth.py               Signature verification, fingerprint
│       ├── crypto.py             Stake minting (RS256 signing)
│       ├── schema.sql            Database schema
│       ├── endpoint_probe.py     Public-address, TLS and service admission checks
│       ├── discovery.py          Discovery schema, normalization and ranking
│       ├── discovery_maintenance.py  Coordinated random health sweeps
│       └── routes/
│           ├── challenge.py      POST /challenge — nonce issuance
│           ├── register.py       POST /register
│           ├── stake.py          POST /stake
│           ├── lookup.py         GET /key/{fp}, /handle/{tag}, /registry/public-key
│           ├── rotate.py         POST /rotate/challenge, /rotate
│           ├── revoke.py         POST /revoke, /revoke/email-*
│           └── discovery.py      GET /discovery, POST /discovery/advertise
│
├── client/                       React + TypeScript + Vite frontend
│   └── src/
│       ├── pages/
│       │   ├── Landing.tsx       Public landing page
│       │   ├── Onboarding.tsx    Keypair generation / import flow
│       │   └── AppPage.tsx       Main note feed (WS, subscriptions, UI)
│       ├── crypto/
│       │   ├── keystore.ts       IndexedDB key storage and rotation recovery
│       │   ├── jwt.ts            Frame signing, verification, PEM import
│       │   └── unt.ts            UNT building and verification
│       ├── api/
│       │   ├── broker.ts         WebSocket connection
│       │   ├── brokerPool.ts     Independent broker connections and R/P permissions
│       │   └── registry.ts       Registry HTTP calls
│       ├── discovery/            Automatic advertisement outbox/retries
│       ├── store/
│       │   ├── identity.tsx      React context for user identity
│       │   └── notes.ts          IndexedDB note storage
│       └── types/
│           └── protocol.ts       TypeScript types for all protocol structures
│
├── design/
│   └── unt-reference.md          Wire format and verification specification
│
├── test/
│   └── broker_connect.py         WebSocket smoke test
│
├── docker-compose.yml
├── Makefile
└── Procfile
```

---

## Running the Stack

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

### Quick start

```bash
# 1. Copy environment templates
cp registry/.env.example registry/.env
cp broker/.env.example broker/.env
cp client/.env.example client/.env

# 2. Generate an RSA-4096 keypair for the registry and add to registry/.env
openssl genrsa -out registry_key.pem 4096
openssl rsa -in registry_key.pem -pubout -out registry_key_pub.pem
# Paste registry_key.pem content as REGISTRY_PRIVATE_KEY_PEM (replace newlines with \n)
# Paste registry_key_pub.pem content as REGISTRY_PUBLIC_KEY_PEM

# 3. Start everything
make up
```

Services:

| Service  | URL                          |
|----------|------------------------------|
| Client   | https://localhost:5173        |
| Registry | http://localhost:8000        |
| Broker   | ws://localhost:8080/ws       |
| Postgres | localhost:5432               |

The client and registry reload source changes in development. The broker runs with `go run` and needs `docker compose restart broker` after Go changes. The client uses a self-signed development HTTPS certificate. To rebuild and recreate the full stack without deleting its database volume, run `docker compose up -d --build --force-recreate`.

### Without Docker

Requires: Python 3.11+, Go 1.21+, Node.js 22.15+ or Node.js 24+, PostgreSQL 15+

```bash
# Postgres — create database
psql -c "CREATE DATABASE sigil;"
psql sigil < registry/src/registry/schema.sql

# Registry
cd registry
python -m venv .venv && .venv/bin/pip install -r requirements.txt
PYTHONPATH=src .venv/bin/uvicorn registry.main:app --reload --port 8000 --no-proxy-headers

# Broker (separate terminal)
cd broker
set -a; . ./.env; set +a
go run ./cmd/broker

# Client (separate terminal)
cd client
npm install && npm run dev
```

---

## Configuration Reference

Copy the per-service `.env.example` files as shown above. The root `.env.example` is a consolidated reference. The registry and Vite load their service `.env` files; the native Go broker reads process environment variables, so source `broker/.env` or use the Procfile. Compose loads each service file and provides internal Docker routing overrides.

### Registry (`registry/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | no | `postgresql://sigil:sigil@localhost:5432/sigil` | PostgreSQL connection string |
| `REGISTRY_PRIVATE_KEY_PEM` | yes | — | RSA-4096 private key, newlines as `\n` |
| `REGISTRY_PUBLIC_KEY_PEM` | yes | — | Corresponding public key, newlines as `\n` |
| `REGISTRY_DOMAIN` | no | — | Fallback registry domain for calls without a request host. A direct or trusted proxy host always takes precedence. |
| `FORWARDED_ALLOW_IPS` | no | `127.0.0.1,::1` | Trusted reverse-proxy IPs or CIDRs. Forwarded public host and protocol are accepted only from these peers. `*` is suitable only when the registry is reachable exclusively through a trusted proxy. |
| `DISCOVERY_RECHECK_INTERVAL_SECONDS` | no | `21600` | Seconds between coordinated random advertisement sweeps; `86400` is daily and `0` disables background sweeps. |
| `DISCOVERY_RECHECK_SAMPLE_SIZE` | no | `20` | Maximum randomly sampled advertisements per sweep (`1`–`1000`). |
| `EMAIL_SMTP_HOST` | no | — | Reserved for email delivery; not implemented yet |
| `EMAIL_SMTP_PORT` | no | `587` | SMTP port |
| `EMAIL_SMTP_USER` | no | — | Reserved SMTP username |
| `EMAIL_SMTP_PASS` | no | — | Reserved SMTP password |
| `EMAIL_FROM_ADDRESS` | no | — | Reserved sender address |

### Broker (`broker/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REGISTRY_PUBLIC_KEY_URL` | no | — | Optional key endpoint mapping for that URL’s host. Fetched lazily when its issuer is seen. |
| `REGISTRY_KEY_URLS` | no | `{}` | JSON map from issuer (`host[:port]`) to an explicit key endpoint; supports local/private registries and Docker service addresses. |
| `REGISTRY_KEY_TTL_SECONDS` | no | `300` | Lifetime of successfully fetched registry keys before the next UNT triggers a refresh. |
| `BROKER_PORT` | no | `8080` | Port to listen on |
| `MIN_FRESHNESS_SCORE` | no | `1` | Drop UNTs with freshness score below this (0–5) |
| `MAX_FRAME_BYTES` | no | `262144` | Max WebSocket frame size in bytes (256 KB) |
| `MAX_CONTENT_BYTES` | no | `4096` | Max note content length in bytes |
| `MAX_RELAY_BATCH` | no | `25` | Max notes allowed in a single `note_relay` frame |

For verification, the broker reads each UNT’s stake issuer and obtains its corresponding key. A missing or expired usable cache entry causes an HTTPS fetch from `https://<issuer>/registry/public-key`; cached lookup failures can defer the retry. It verifies the stake with that issuer’s key, then the outer frame with the endorsed author key, before routing. Failed lookup or validation drops the frame. Automatic issuer-key retrieval requires valid TLS certificates, disallows redirects, and refuses private/internal network destinations. Explicit endpoint mappings are available for local development.

The [key-cache](#broker-registry-key-cache) and [broadcast deduplication](#broker-broadcast-deduplication-and-forwarding-policy) sections describe this broker’s fixed capacities and current policies; they are not additional signed-UNT wire fields.

### Client (`client/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_REGISTRY_URL` | no | Suggested HTTPS registry URL and onboarding discovery source (HTTP is allowed only on loopback for development), pre-filled and editable during onboarding (e.g. `http://localhost:8000`). If unset, the field starts empty. |
| `VITE_DEFAULT_BROKER_URLS` | no | JSON array of suggested broker URLs, e.g. `["/ws","wss://relay.example/ws"]`. Used for new identities. A valid list (including `[]`) takes precedence over the legacy single suggestion. Add/remove connections in the bottom broker menu. |
| `VITE_DEFAULT_BROKER_URL` | no | Legacy single suggested WebSocket URL (`ws://`, `wss://`, or same-origin `/ws`), used when the JSON list is absent/invalid. If neither suggestion is set, add brokers in the bottom broker menu. |
| `VITE_DEFAULT_CHANNELS` | no | Comma-separated suggested channels for a new identity. If unset, join a channel using Add Channel. |
| `VITE_MAX_NOTE_BYTES` | no | Composer UTF-8 byte limit (default `4096`); match the broker’s `MAX_CONTENT_BYTES`. |
| `VITE_MAX_FRAME_BYTES` | no | Serialized history relay frame limit (default `262144`, minimum `1024`); match the broker’s `MAX_FRAME_BYTES`. |
| `VITE_HISTORY_BATCH_SIZE` | no | Original notes per relay page (default `25`, range `1..25`; larger values cap at `25`); must not exceed the broker’s `MAX_RELAY_BATCH`. |
| `VITE_HISTORY_TIMEOUT_MS` | no | Reply collection timeout in milliseconds (default `5000`, range `500..60000`). Silent channel-history requests make up to three attempts; direct `request_note` lookups expire once without automatic retries. |
| `VITE_REGISTRY_TIMEOUT_MS` | no | Registry HTTP request deadline in milliseconds (default `10000`, range `500..120000`), including reading the response body. Timeout errors are shown with a retry action. |
| `VITE_REPOSITORY_URL` | no | Repository URL for source, README and setup links. Defaults to `https://github.com/WizzyGeek/Sigil`; override for a fork. |
| `DEV_BROKER_PROXY_URL` | no | Vite development proxy target for `/ws` (e.g. `ws://localhost:8080`). Required only when using the development proxy. |

Handles and signed stake issuers use the public registry request host, including its port when present. A proxy can preserve `Host` or supply `X-Forwarded-Host` / `Forwarded: host=...`; configure its IP or network in `FORWARDED_ALLOW_IPS`. It must overwrite untrusted forwarding headers before passing requests on. For chained host values, the last value supplied by the immediate trusted proxy is used. The browser’s `Origin` header identifies the client website and is never used as the registry identity. `REGISTRY_DOMAIN` is used only when no request host is available (including calls without an HTTP request). It never overrides a direct or trusted forwarded host. Calls with neither a host nor a configured fallback fail explicitly instead of assuming localhost.

Start Uvicorn with `--no-proxy-headers` (already configured in Docker and the Procfile). The application processes forwarded headers after checking the original socket peer; this avoids checking an already-rewritten client address. Saved account handles refresh from newly verified stakes. Previously signed notes retain their original issuer.

Client `VITE_*` variables are public build-time values; rebuild/redeploy the client to change them. They must never contain secrets. User-saved connection settings take precedence over deployment suggestions. Registry requests reject redirects and rely on browser TLS certificate validation. `DEV_BROKER_PROXY_URL` configures the Vite server only; it does not configure production hosting. Compose maps `/ws` to the broker container and preserves the registry’s public issuer when mapping its key endpoint.

Broker URL lists, read/publish permissions, channels, and associated registry handles are stored locally per key. The active identity determines the signing key and registry used for challenge and stake requests; incoming notes are verified using the registry key bound to their signed stake’s `iss` domain. The client derives each issuer from the configured registry URL’s host and port; unknown issuers and signatures made with another registry’s key are rejected. The same binding applies to control frames, fetched stakes, restored identities, and cached notes. Configure one registry URL per issuer; different paths on the same host cannot represent separate registry identities. The broker discovers public registry keys by issuer and caches them; local/private registries require an explicit broker endpoint mapping.

The browser client supports generating keys, importing unencrypted PKCS#8 PEM keys, and restoring an existing registered identity through **Import Identity**. If browser identity metadata is lost but its IndexedDB key remains, **Restore the key stored in this browser** can recover it without exporting the private key. Newly generated registration keys are staged separately and reused after interrupted attempts; the active selection changes only after registration or restoration succeeds, and previously saved keys are preserved. Generated keys are shown once for PEM backup before being retained as non-extractable signing keys. The identity menu supports resumable single-registration or grouped bulk rotation with generated or imported keys, signed revocation of the selected registration, revoke-all with deletion of only the selected key, and saved identity switching. Encrypted backup downloads remain to be implemented. Entering a recovery email during onboarding sends only its normalized SHA-256 hash. Recovery delivery is unfinished: the registry email-init endpoint currently returns a development debug token and does not send an email.

---

## Development

### Makefile targets

```bash
make up      # docker compose up (foreground)
make build   # rebuild all images
make down    # stop and remove containers
make logs    # tail all service logs
make ps      # show running services
make test    # run all test suites
```

### Running tests individually

Broker cache, issuer validation, and transport tests: `cd broker && go test -race ./...`.

Client regression checks (Node 22.15+ or 24+): `npm --prefix client test`. Production and TypeScript validation: `npm --prefix client run build`.

```bash
# Registry (pytest)
docker compose run --build --rm registry python -m pytest

# Broker (go test)
docker compose run --build --rm broker go test ./...

# Client (TypeScript and regression tests)
docker compose run --build --rm client npm run typecheck
docker compose run --build --rm client npm test
```

### Registry API quick reference

```
POST /challenge                     → { nonce, expires_at }
POST /register                      → { fingerprint, handle }
POST /stake                         → { stake: [stake_payload, stake_sig_b64] }
GET  /key/{fingerprint}              → { fingerprint, public_key, user_tag, display_name }
GET  /handle/{user_tag}              → { fingerprint, user_tag, display_name }
GET  /registry/public-key            → { public_key }
POST /rotate/challenge              → { nonce, expires_at }
POST /rotate                        → { new_fingerprint }
POST /revoke                        → { revoked: true }
POST /revoke/email-init             → { message, debug_token }  # development only; no email sent
POST /revoke/email-confirm          → { revoked: true, fingerprint }
GET  /discovery?kind=registry|broker&query=... → { entries: [{kind, url}] }  # extension
POST /discovery/advertise            → { advertised, accepted, rejected }  # extension
```

### Client validation and remaining functionality

The client regression suite covers issuer/key binding, signed peer-history pagination, same-second cursors, multiple peers, overlapping data, same-identity sessions, multiple independent brokers, independent read/publish permissions, global timeline sorting/deduplication, frame-size budgeting, retries after lost pages or temporary storage failures, mixed trusted/untrusted history, cancellation, and unsolicited reply rejection. Broker tests cover request-correlated routing in addition to signature validation and bounded caches. Browser checks use isolated profiles to verify IndexedDB migration and actual peer transfers through the local broker.

New note and relay signatures use consistent canonical JSON across JavaScript, Go, and Python: recursively sorted object keys, compact encoding, UTF-8 text without HTML escaping, and escaped U+2028/U+2029 separators. This avoids failures for notes containing `&`, `<`, emoji, or accented text. Verification binds each stake issuer to its registry key before trusting the author key.

Still outside this client implementation: encrypted identity/configuration backup and restore, production email recovery, offline peer discovery, centralized persistent archive nodes, and rate limiting for genuinely new valid JTIs. The broker's bounded LRU cache suppresses replay while a JTI is retained; it is not a rate limit for novel notes.
