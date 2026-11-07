# Sigil — Decentralized Notes Protocol (DNP)

Sigil is a protocol and reference implementation for publishing cryptographically signed notes between users without trusting any server with either your keys or your content.

**Core guarantees:**

- Private keys never leave your device — ever
- Servers never store notes — ever
- Every note you receive carries a mathematical proof of authorship
- Forging, tampering, or replaying a note is computationally infeasible

The architecture has three independent services. They do not talk to each other. Only clients talk to both.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [How It Works](#how-it-works)
   - [Identity and Registration](#identity-and-registration)
   - [UNT — Unified Note Token](#unt--unified-note-token)
   - [Freshness Score](#freshness-score)
   - [Publishing a Note](#publishing-a-note)
   - [Receiving and Verifying Notes](#receiving-and-verifying-notes)
   - [Requesting History](#requesting-history)
3. [Protocol Commands](#protocol-commands)
4. [Security Model](#security-model)
5. [Directory Structure](#directory-structure)
6. [Running the Stack](#running-the-stack)
7. [Configuration Reference](#configuration-reference)
8. [Development](#development)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         CLIENT                              │
│  • Holds RSA-4096 keypair (private key non-extractable)     │
│  • Signs every outgoing note and command                    │
│  • Verifies every incoming note independently               │
│  • Stores all verified notes in IndexedDB                   │
└────────────────┬────────────────────────┬───────────────────┘
                 │ HTTPS                  │ WebSocket
                 ▼                        ▼
┌───────────────────────┐    ┌──────────────────────────────┐
│       REGISTRY        │    │            BROKER            │
│  (Python / FastAPI)   │    │          (Go / WS)           │
│                       │    │                              │
│  • Issues identity    │    │  • Verifies every frame      │
│    endorsements       │    │    before routing            │
│    (stakes)           │    │  • Fans out to subscribers   │
│  • Stores: public     │    │  • Routes unicast replies    │
│    keys + handles     │    │  • Stores: NOTHING           │
│  • Never sees notes   │    │  • Anyone can run one        │
└───────────────────────┘    └──────────────────────────────┘
         ▲                              ▲
         └──────────────────────────────┘
         Registry and Broker NEVER communicate
```

The Registry is partially trusted — it endorses keys and signs those endorsements with its own private key. The Broker is completely untrusted — it only passes through messages it cannot alter without detection. The Client trusts nothing it cannot verify cryptographically.

---

## How It Works

### Identity and Registration

Every user identity is an RSA-4096 keypair generated locally in the browser. The private key is stored in IndexedDB with the Web Crypto `non-extractable` flag — it cannot be read by JavaScript code, only used for signing.

**Fingerprint** — the canonical identifier for a keypair:

```
fingerprint = "sha256:" + hex(SHA-256(SPKI DER bytes of public key))
```

**Fully-qualified user identifier:**

```
@alice@registry.example.com
```

The `@alice` part (user tag) is local to a specific registry. The same keypair can hold different handles on multiple registries simultaneously:

```
@alice@registry.sigil.local
@ali@orbit.example.com
```

**Registration flow:**

1. Client generates keypair locally
2. Client requests a nonce (UUID challenge) from the registry
3. Client signs the nonce with its private key
4. Client submits public key + signed nonce + desired handle to registry
5. Registry verifies the signature, stores the public key and handle
6. Client is now registered — the registry has no secret it can use to impersonate you

**Stake issuance** — happens every time you want to publish a note:

1. Client requests a fresh nonce
2. Client signs the nonce with its private key
3. Client sends the signed nonce to `POST /stake`
4. Registry issues a signed endorsement (the stake): `{ public_key, user_tag, display_name, iat, iss }`
5. Client caches the stake for ~25 seconds (maximises freshness score)
6. Client embeds the stake inside every UNT it signs

---

### UNT — Unified Note Token

A UNT is the single unit of data in the protocol. It is a nested signed structure that contains everything needed to verify it — no network calls required at verification time.

**Wire format:** a two-element JSON array

```json
[ payload_object, "base64-encoded-signature" ]
```

The payload object is a raw JSON object (never base64-encoded). The signature is RSA-4096 PKCS1v15 SHA-256 over the canonical JSON of the payload (keys sorted, no extra whitespace).

**Outer payload** (signed by the author's private key):

```json
{
  "jti":       "550e8400-e29b-41d4-a716-446655440000",
  "iat":       1719532800,
  "type":      "note",
  "channel":   "news,tech",
  "content":   "Hello, decentralized world.",
  "reply_to":  null,
  "stake":     [ <stake_payload>, "<stake_sig_b64>" ],
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
- The `stake_iat` field must equal `stake.iat` — this extra binding prevents stake-swap attacks even if someone managed to produce two stakes with the same timestamp

---

### Freshness Score

The freshness score (0–5) measures how recently the registry endorsed the author's key relative to when the note was signed. It is tamper-proof because both timestamps are independently signed.

```
delta_t = outer.iat − stake.iat   (seconds)
```

| delta_t | Score | Label     | Meaning |
|---------|-------|-----------|---------|
| < 5s    | 5     | Excellent | Stake fetched immediately before signing |
| 5–30s   | 4     | Strong    | Normal network latency |
| 30s–3m  | 3     | Good      | Slight delay |
| 3–30m   | 2     | Weak      | Stake reused across notes |
| 30m–24h | 1     | Poor      | Long-lived stake |
| > 24h   | 0     | Untrusted | Stake too old |

The client UI shows freshness as a lock icon on each note card. Brokers can be configured with a minimum freshness threshold and will silently drop frames below it.

---

### Publishing a Note

1. Client fetches a fresh stake from the registry (or uses a cached one ≤ 25s old)
2. Client constructs the outer payload with the stake embedded
3. Client signs the outer payload with its private key using Web Crypto
4. Client sends the resulting UNT over its WebSocket connection to the broker
5. Broker verifies the UNT (see below), then fans out the raw bytes to all channel subscribers

The broker never modifies the UNT. Subscribers receive the exact bytes the author signed.

---

### Receiving and Verifying Notes

Every client independently runs the full 4-step verification algorithm on every incoming frame. There is no shortcut:

```
Step 1 — Parse
  Extract [outer_payload, outer_sig] from the frame
  Extract stake = outer_payload.stake = [stake_payload, stake_sig]

Step 2 — Verify registry-signed stake frame
  Verify stake_sig using the registry public key (baked into the client at build time)
  If this fails → DROP. Stop.
  Extract: public_key, user_tag, display_name, iat from verified stake_payload

Step 3 — Verify author-signed outer frame
  Verify outer_sig using public_key from the verified stake
  If this fails → DROP. Stop.

Step 4 — Apply invariants
  Check outer_payload.stake_iat == stake_payload.iat
  Check outer_payload.jti is not in the local seen-list (deduplication)
  Compute freshness score from (outer.iat − stake.iat)
  If all pass → UNT is valid. Store in IndexedDB. Display.
```

A note that passes all four steps is proven to have been:
- Written by someone whose keypair was endorsed by the registry at `stake.iat`
- Signed at `outer.iat` by that exact keypair
- Not modified in transit
- Not previously seen (jti deduplication)

---

### Multiple broker connections and the timeline

The topology is **bipartite**: connections are only between clients and brokers. Brokers do not communicate with other brokers, and clients do not open direct peer connections.

A client can add several broker WebSocket URLs in **Settings → Brokers**. Every connection has independent status and reconnection behavior; removing one leaves the others connected. The configured URL list is saved per identity, and older saved single-broker settings migrate automatically.

Newly authored notes are signed **once** and published with the **same JTI** to every connected broker. Received notes are verified and saved locally; **they are never automatically forwarded to another broker**. A note learned on broker 1 becomes available on broker 2 only when a broker-2 peer requests history and this client responds through broker 2. History requests, replies, pagination and request correlation are kept on their respective broker connection.

The client combines local notes, live arrivals and history from all broker connections into one timeline, deduplicated globally by JTI and sorted by signed `iat` (then JTI for stable same-second ordering). Signature and registry-issuer checks apply before an incoming note can enter that shared cache. Initial channel loads follow the latest note, and new notes continue to scroll down while the reader is near the bottom. Scrolling up pauses automatic following; **Latest note** returns to the bottom. Sending a note also moves to the latest position.

### Requesting History

Brokers store no notes. A client subscribes to its joined channels on each connected broker and independently requests history for the active channel after connecting, reconnecting, or switching channels. **Refresh history** restarts the exchange manually.

1. The requester sends a fresh, signed `request_notes` with a snapshot boundary `till`. The initial boundary includes notes from the current second.
2. Every connected peer in that channel can respond, including a sole peer. There is no random sampling that can leave a request unanswered.
3. Each peer reads a page from its local IndexedDB, verifies the original notes, and sends a signed `note_relay`. The reply contains `to` (requester fingerprint), `request_jti` (the original request), and `peer_id` (the responder's session ID).
4. The broker uses the request JTI to route the response to the exact requesting connection, including when several tabs/devices share a fingerprint. This correlation metadata shares the bounded broadcast JTI cache and expires after five minutes; it stores no notes.
5. The requester checks the envelope, recipient, outstanding request, channel, issuer-specific signatures, and each original note. Individual originals that fail verification or use an untrusted registry are skipped, counted in the UI, and never saved; the authenticated page cursor still permits fetching older trusted notes. An atomic IndexedDB transaction saves each JTI once, even when live traffic and several peers supply it concurrently.
6. Replies include `has_more` and `next_cursor: {iat, jti}`. The requester pages each responding session independently, sending fresh request JTIs and targeting that peer's fingerprint and `peer_id`. The compound cursor prevents losing notes sharing a timestamp and prevents one peer's cursor from skipping another peer's history.
7. Pages respect both the configured batch count and the serialized frame byte limit. Fresh relay envelopes can carry original notes older than the broker's five-minute broadcast cutoff. Empty replies acknowledge a peer with no matching notes.

Requests that receive no reply retry up to three times, always with a **new JTI** so broker deduplication does not swallow retries. The default reply/peer-discovery window is five seconds per attempt. The UI reports progress, peer counts, missing peers, or incomplete transfers. Reconnecting restarts synchronization, and **Refresh history** retries a partial transfer without duplicating stored notes.

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
| `note_relay` | peer → broker → requester | Response to a request_notes |

**Channels** are plain strings (e.g. `"news,tech"`). They are broker-local, implicit (no registration needed), and matched by exact string equality. There is no special wildcard subscription. The client suggests `VITE_DEFAULT_CHANNELS` when configured; otherwise users join channels explicitly.

---

## Security Model

### What servers cannot do

**The Broker:**
- Cannot forge a UNT (no user private key)
- Cannot modify note content (outer signature breaks)
- Cannot forge a stake (no registry private key)
- Cannot impersonate any user or the registry

**The Registry:**
- Cannot read note content (notes never pass through it)
- Cannot forge a UNT (no user private key)
- Cannot reveal plaintext emails (only SHA-256 hashes stored; never returned by any API)

**No one:**
- Can alter a UNT in transit (both signatures break)
- Can replay an old UNT (jti seen-list on every client)
- Can use a stake issued for a different author (outer signature binds keypair to stake)
- Can fake the freshness score (both iat values are independently signed)

### What servers can do

**The Broker** can censor by refusing to relay specific UNTs, and can observe metadata (who posts, when, to which channel). Mitigation: connect to multiple independent brokers.

**The Registry** can issue fraudulent stakes (it is partially trusted), or refuse stake issuance entirely. Mitigation: clients pin the registry public key at build time; you can run your own registry.

### Key rotation

1. Client requests two nonces simultaneously: one for the old key, one for the new key
2. Client signs `old_nonce` with the old private key
3. Client signs `new_nonce` with the new private key
4. Registry verifies both signatures atomically — all-or-nothing
5. Old record is deleted; new record is created, preserving `user_tag`, `display_name`, and `registered_at`

### Key revocation

**Path A — key intact:**

```
POST /revoke { "fingerprint": "sha256:...", "signed_nonce": "..." }
```

Registry verifies the signature and deletes the record.

**Path B — key compromised or lost (email recovery):**

1. `POST /revoke/email-init { "email": "<plaintext>" }`
   — Registry hashes the email and compares it to the stored hash. Sends an OTP if they match. Silently does nothing if they don't (prevents email enumeration).
2. `POST /revoke/email-confirm { "token": "<OTP>" }`
   — Registry verifies the OTP and deletes the record.

Note: the email address is the only plaintext ever sent to the registry. It is immediately hashed and the plaintext is discarded. It is never stored and never returned in any API response.

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
│       └── protocol/
│           ├── unt.go            4-step UNT verification algorithm
│           └── commands.go       UNT type constants
│
├── registry/                     Python FastAPI identity provider
│   └── src/registry/
│       ├── main.py               App setup, CORS, router registration
│       ├── config.py             Pydantic settings (reads .env)
│       ├── db.py                 PostgreSQL connection pool (asyncpg)
│       ├── auth.py               Signature verification, fingerprint
│       ├── crypto.py             Stake minting (RS256 signing)
│       ├── schema.sql            Database schema
│       └── routes/
│           ├── challenge.py      POST /challenge — nonce issuance
│           ├── register.py       POST /register
│           ├── stake.py          POST /stake
│           ├── lookup.py         GET /key/{fp}, /handle/{tag}, /registry/public-key
│           ├── rotate.py         POST /rotate/challenge, /rotate
│           └── revoke.py         POST /revoke, /revoke/email-*
│
├── client/                       React + TypeScript + Vite frontend
│   └── src/
│       ├── pages/
│       │   ├── Landing.tsx       Public landing page
│       │   ├── Onboarding.tsx    Keypair generation / import flow
│       │   └── AppPage.tsx       Main note feed (WS, subscriptions, UI)
│       ├── crypto/
│       │   ├── keystore.ts       IndexedDB key storage (non-extractable)
│       │   ├── jwt.ts            Frame signing, verification, PEM import
│       │   └── unt.ts            UNT building and verification
│       ├── api/
│       │   ├── broker.ts         WebSocket client
│       │   └── registry.ts       Registry HTTP calls
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
| `DATABASE_URL` | yes | `postgresql://sigil:sigil@localhost:5432/sigil` | PostgreSQL connection string |
| `REGISTRY_PRIVATE_KEY_PEM` | yes | — | RSA-4096 private key, newlines as `\n` |
| `REGISTRY_PUBLIC_KEY_PEM` | yes | — | Corresponding public key, newlines as `\n` |
| `REGISTRY_DOMAIN` | no | — | Fallback registry domain for calls without a request host. A direct or trusted proxy host always takes precedence. |
| `FORWARDED_ALLOW_IPS` | no | `127.0.0.1,::1` | Trusted reverse-proxy IPs or CIDRs. Forwarded public host and protocol are accepted only from these peers. `*` is suitable only when the registry is reachable exclusively through a trusted proxy. |
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

The broker discovers each UNT’s stake issuer and fetches `https://<issuer>/registry/public-key`. It verifies the stake with that issuer’s key, then the outer frame with the endorsed author key, before routing. Failed lookup or validation drops the frame. Public discovery requires valid TLS certificates, disallows redirects, and refuses private/internal network destinations. Explicit endpoint mappings are available for local development.

The registry cache holds up to **10,000** records, including unsuccessful lookups. A missing issuer whose fetch fails gets a **55-second** retry delay. A failed refresh of an expired record uses **1.5 × its previous TTR**. Cached failures suppress network retries until expiry; expired keys are never used. Successful fetches reset the lifetime to `REGISTRY_KEY_TTL_SECONDS` (default five minutes). Expired records retain retry history until refreshed or evicted. When full, the earliest-expiring record is evicted only if it expires strictly before the new record; otherwise the fetched result is used for the current frame without being cached. Concurrent lookups for one issuer share a fetch, and slow registries do not block the central routing loop.

For verified `note` and `request_notes` broadcasts, the broker drops frames older than **five minutes** before accessing the JTI cache. Recent frames share a **global, 100,000-entry LRU JTI cache** across both message types, channels, and authors. A duplicate refreshes its recency but is never forwarded again while cached. At capacity, eviction removes the least recently observed JTI. Alternating two recent JTIs cannot cycle them through a slot formerly protected by hot frequency counts; both remain cached and are dropped. Invalid signatures, missing JTIs, stale frames, and oversized note content cannot reserve cache entries. Other control types and history relay contents do not use this broadcast deduplication cache.

### Client (`client/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_REGISTRY_URL` | no | Suggested HTTPS registry URL (HTTP is allowed only on loopback for development), pre-filled and editable during onboarding (e.g. `http://localhost:8000`). If unset, the field starts empty. |
| `VITE_DEFAULT_BROKER_URLS` | no | JSON array of suggested broker URLs, e.g. `["/ws","wss://relay.example/ws"]`. Used for new identities. A valid list (including `[]`) takes precedence over the legacy single suggestion. Add/remove connections in Settings. |
| `VITE_DEFAULT_BROKER_URL` | no | Legacy single suggested WebSocket URL (`ws://`, `wss://`, or same-origin `/ws`), used when the JSON list is absent/invalid. If neither suggestion is set, add brokers in Settings. |
| `VITE_DEFAULT_CHANNELS` | no | Comma-separated suggested channels for a new identity. If unset, join a channel using Add Channel. |
| `VITE_MAX_NOTE_BYTES` | no | Composer UTF-8 byte limit (default `4096`); match the broker’s `MAX_CONTENT_BYTES`. |
| `VITE_MAX_FRAME_BYTES` | no | Serialized history relay frame limit (default `262144`, minimum `1024`); match the broker’s `MAX_FRAME_BYTES`. |
| `VITE_HISTORY_BATCH_SIZE` | no | Original notes per relay page (default `25`, range `1..25`; larger values cap at `25`); must not exceed the broker’s `MAX_RELAY_BATCH`. |
| `VITE_HISTORY_TIMEOUT_MS` | no | Reply collection / retry timeout in milliseconds (default `5000`, range `500..60000`); a silent request makes up to three attempts. |
| `VITE_REGISTRY_TIMEOUT_MS` | no | Registry HTTP request deadline in milliseconds (default `10000`, range `500..120000`), including reading the response body. Timeout errors are shown with a retry action. |
| `VITE_REPOSITORY_URL` | no | Repository URL for landing-page source and setup links. Those links are hidden when unset. |
| `DEV_BROKER_PROXY_URL` | no | Vite development proxy target for `/ws` (e.g. `ws://localhost:8080`). Required only when using the development proxy. |

Handles and signed stake issuers use the public registry request host, including its port when present. A proxy can preserve `Host` or supply `X-Forwarded-Host` / `Forwarded: host=...`; configure its IP or network in `FORWARDED_ALLOW_IPS`. It must overwrite untrusted forwarding headers before passing requests on. For chained host values, the last value supplied by the immediate trusted proxy is used. The browser’s `Origin` header identifies the client website and is never used as the registry identity. `REGISTRY_DOMAIN` is used only when no request host is available (including calls without an HTTP request). It never overrides a direct or trusted forwarded host. Calls with neither a host nor a configured fallback fail explicitly instead of assuming localhost.

Start Uvicorn with `--no-proxy-headers` (already configured in Docker and the Procfile). The application processes forwarded headers after checking the original socket peer; this avoids checking an already-rewritten client address. Saved account handles refresh from newly verified stakes. Previously signed notes retain their original issuer.

Client `VITE_*` variables are public build-time values; rebuild/redeploy the client to change them. They must never contain secrets. User-saved connection settings take precedence over deployment suggestions. Registry requests reject redirects and rely on browser TLS certificate validation. `DEV_BROKER_PROXY_URL` configures the Vite server only; it does not configure production hosting. Compose maps `/ws` to the broker container and preserves the registry’s public issuer when mapping its key endpoint.

Broker URL lists, channels, registry accounts (including their handles), and the selected stake provider are stored locally per identity. Switching providers changes challenge and stake requests; incoming notes are verified using the key bound to their signed stake’s `iss` domain. The client derives each issuer from the configured registry URL’s host and port; unknown issuers and signatures made with another registry’s key are rejected. The same binding applies to control frames, fetched stakes, restored identities, and cached notes. Configure one registry URL per issuer; different paths on the same host cannot represent separate registry identities. The broker discovers public registry keys by issuer and caches them; local/private registries require an explicit broker endpoint mapping.

The browser client supports generating keys, importing unencrypted PKCS#8 PEM keys, and restoring an existing registered identity through **Import Identity**. If browser identity metadata is lost but its IndexedDB key remains, **Restore the key stored in this browser** can recover it without exporting the private key. Newly generated registration keys are staged separately and reused after interrupted attempts; the active key is replaced only after registration or restoration succeeds. Private keys are stored as non-extractable keys and cannot be exported. Key rotation and revocation are not implemented in the browser client; use the registry API for those operations. Entering a recovery email during onboarding sends only its normalized SHA-256 hash. Recovery delivery is unfinished: the registry email-init endpoint currently returns a development debug token and does not send an email.

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
```

### Client validation and remaining functionality

The client regression suite covers issuer/key binding, signed peer-history pagination, same-second cursors, multiple peers, overlapping data, same-identity sessions, multiple independent brokers, global timeline sorting/deduplication, frame-size budgeting, retries after lost pages or temporary storage failures, mixed trusted/untrusted history, cancellation, and unsolicited reply rejection. Broker tests cover request-correlated routing in addition to signature validation and bounded caches. Browser checks use isolated profiles to verify IndexedDB migration and actual peer transfers through the local broker.

New note and relay signatures use consistent canonical JSON across JavaScript, Go, and Python: recursively sorted object keys, compact encoding, UTF-8 text without HTML escaping, and escaped U+2028/U+2029 separators. This avoids failures for notes containing `&`, `<`, emoji, or accented text. Verification binds each stake issuer to its registry key before trusting the author key.

Still outside this client implementation: safe multi-registry key rotation/revocation, export of non-extractable browser keys, production email recovery, offline peer discovery, centralized persistent archive nodes, and rate limiting for genuinely new valid JTIs. The broker's bounded LRU cache suppresses replay while a JTI is retained; it is not a rate limit for novel notes.
