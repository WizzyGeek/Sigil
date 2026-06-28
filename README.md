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

Step 2 — Verify stake (inner JWT)
  Verify stake_sig using the registry public key (baked into the client at build time)
  If this fails → DROP. Stop.
  Extract: public_key, user_tag, display_name, iat from verified stake_payload

Step 3 — Verify outer JWT
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

### Requesting History

When a client connects, it may not find any notes on the broker because brokers store nothing. The `request_notes` mechanism lets clients ask peers for their stored notes.

1. Client sends a `request_notes` UNT to its channel
2. Broker fans out to all subscribers
3. Each subscriber independently decides whether to respond using a deterministic hash:

   ```
   hash = SHA-256(request_jti_bytes || own_fingerprint_bytes)
   respond if hash[0] < 0x40   // ~25% probability → log(N) responders
   ```

4. Responding peers send a `note_relay` UNT containing up to `MAX_RELAY_BATCH` stored notes
5. The `note_relay.to` field contains the requester's fingerprint
6. Broker routes the relay to the correct connection via its in-memory fingerprint index

This gives history availability proportional to the number of connected peers, without any central note storage.

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

**Channels** are plain strings (e.g. `"news,tech"`). They are broker-local, implicit (no registration needed), and matched by exact string equality. The default channel is `"*"`.

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
| Client   | http://localhost:5173        |
| Registry | http://localhost:8000        |
| Broker   | ws://localhost:8080/ws       |
| Postgres | localhost:5432               |

Hot-reload is enabled for all services in development mode. Editing any source file restarts the relevant service automatically.

### Without Docker

Requires: Python 3.11+, Go 1.22+, Node.js 20+, PostgreSQL 15+

```bash
# Postgres — create database
psql -c "CREATE DATABASE sigil;"
psql sigil < registry/src/registry/schema.sql

# Registry
cd registry
python -m venv .venv && .venv/bin/pip install -r requirements.txt
PYTHONPATH=src .venv/bin/uvicorn registry.main:app --reload --port 8000

# Broker (separate terminal)
cd broker
go run ./cmd/broker

# Client (separate terminal)
cd client
npm install && npm run dev
```

---

## Configuration Reference

### Registry (`registry/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | `postgresql://sigil:sigil@localhost:5432/sigil` | PostgreSQL connection string |
| `REGISTRY_PRIVATE_KEY_PEM` | yes | — | RSA-4096 private key, newlines as `\n` |
| `REGISTRY_PUBLIC_KEY_PEM` | yes | — | Corresponding public key, newlines as `\n` |
| `REGISTRY_DOMAIN` | yes | `localhost:8000` | Public domain (no scheme), embedded in stakes |
| `EMAIL_SMTP_HOST` | no | — | SMTP host for email OTP (key-recovery path B) |
| `EMAIL_SMTP_PORT` | no | `587` | SMTP port |
| `EMAIL_SMTP_USER` | no | — | SMTP username |
| `EMAIL_SMTP_PASS` | no | — | SMTP password |
| `EMAIL_FROM_ADDRESS` | no | — | From address for OTP emails |

### Broker (`broker/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REGISTRY_PUBLIC_KEY_URL` | yes | — | URL to fetch the registry's public key from |
| `BROKER_PORT` | no | `8080` | Port to listen on |
| `MIN_FRESHNESS_SCORE` | no | `1` | Drop UNTs with freshness score below this (0–5) |
| `MAX_FRAME_BYTES` | no | `262144` | Max WebSocket frame size in bytes (256 KB) |
| `MAX_CONTENT_BYTES` | no | `4096` | Max note content length in bytes |
| `MAX_RELAY_BATCH` | no | `25` | Max notes allowed in a single `note_relay` frame |

### Client (`client/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_REGISTRY_URL` | yes | Base URL of the registry (e.g. `http://localhost:8000`) |
| `VITE_DEFAULT_BROKER_URL` | yes | Default broker WebSocket URL (e.g. `ws://localhost:8080/ws`) |

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

```bash
# Registry (pytest)
docker compose run --rm registry python -m pytest

# Broker (go test)
docker compose run --rm broker go test ./...

# Client (TypeScript type-check)
docker compose run --rm client npm run typecheck
```

### Registry API quick reference

```
POST /challenge                     → { nonce, expires_at }
POST /register                      → { fingerprint }
POST /stake                         → [ stake_payload, stake_sig_b64 ]
GET  /key/{fingerprint}             → { public_key, user_tag, display_name, registered_at }
GET  /handle/{user_tag}             → { fingerprint, public_key, display_name, registered_at }
GET  /registry/public-key           → { public_key }
POST /rotate/challenge              → { old_nonce, new_nonce, expires_at }
POST /rotate                        → { fingerprint }
POST /revoke                        → 204
POST /revoke/email-init             → 204
POST /revoke/email-confirm          → 204
```
