"""Public endpoint directory: URL normalization and deterministic similarity ranking."""
import ipaddress
import re
from difflib import SequenceMatcher
from urllib.parse import urlsplit, urlunsplit

SCHEMA = """
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
"""


def normalize_endpoint(value: str, kind: str) -> str:
    value = value.strip()
    if not value or len(value) > 2048 or any(char.isspace() or ord(char) < 32 for char in value) or '\\' in value:
        raise ValueError('Use an absolute public endpoint URL without whitespace')
    parsed = urlsplit(value)
    schemes = ('https', 'http') if kind == 'registry' else ('wss', 'ws')
    if parsed.scheme not in schemes or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
        raise ValueError('Advertisements require an absolute endpoint without credentials, query strings or fragments')
    host = parsed.hostname.encode('idna').decode().lower()
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == 'localhost'
    if kind == 'registry' and parsed.scheme == 'http' and not loopback:
        raise ValueError('Registry advertisements require HTTPS except on loopback')
    port = parsed.port  # Also rejects malformed/out-of-range ports.
    if ':' in host:
        host = f'[{host}]'
    default = 443 if parsed.scheme in ('https', 'wss') else 80
    authority = host if port is None or port == default else f'{host}:{port}'
    path = parsed.path.rstrip('/') if kind == 'registry' else parsed.path or '/'
    return urlunsplit((parsed.scheme, authority, path, '', ''))


def search_text(value: str) -> str:
    return re.sub(r'^[a-z]+://', '', value.strip().lower()).rstrip('/')


def similarity(url: str, query: str) -> tuple:
    candidate, query = search_text(url), search_text(query)
    if not query:
        return (0, 0, 0, url)
    category = 0 if candidate == query else 1 if candidate.startswith(query) else 2 if query in candidate else 3
    return (category, -SequenceMatcher(None, candidate, query).ratio(), len(candidate), url)


def like_pattern(value: str) -> str:
    return '%' + value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
