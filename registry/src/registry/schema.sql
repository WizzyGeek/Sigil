CREATE TABLE IF NOT EXISTS key_registry (
    fingerprint   TEXT PRIMARY KEY,
    public_key    TEXT NOT NULL,
    user_tag      TEXT NOT NULL UNIQUE,
    display_name  TEXT,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recovery_hints (
    fingerprint TEXT PRIMARY KEY REFERENCES key_registry(fingerprint) ON DELETE CASCADE,
    email_hash  TEXT NOT NULL
);

-- Nonces are short-lived; clean up with a periodic DELETE WHERE expires_at < NOW()
CREATE TABLE IF NOT EXISTS nonces (
    nonce       TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS nonces_expires_idx ON nonces (expires_at);

-- Verified discovery advertisements and coordinated periodic health sampling.

CREATE TABLE IF NOT EXISTS endpoint_advertisements (
    kind TEXT NOT NULL CHECK (kind IN ('registry', 'broker')),
    url TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, url)
);
ALTER TABLE endpoint_advertisements ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
DELETE FROM endpoint_advertisements WHERE verified_at IS NULL;
CREATE INDEX IF NOT EXISTS endpoint_advertisements_recent_idx
    ON endpoint_advertisements (kind, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS discovery_maintenance (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_until TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
    lease_token TEXT
);
INSERT INTO discovery_maintenance (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
