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
