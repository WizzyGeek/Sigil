import base64
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from starlette.requests import Request

from fastapi import HTTPException
from registry.config import settings
from registry.domain import registry_domain
from registry import crypto
from registry.routes import register, stake


def request(host: str) -> Request:
    return Request({"type": "http", "method": "POST", "scheme": "https", "path": "/", "headers": [(b"host", host.encode())], "server": ("internal", 8000)})


@pytest.mark.parametrize("host", ["localhost:8000", "sigil-q5x4.vercel.app", "registry.example.org"])
def test_domain_follows_registry_request(monkeypatch, host):
    monkeypatch.setattr(settings, "registry_domain", "fallback.example.org")
    assert registry_domain(request(host)) == host


@pytest.mark.asyncio
async def test_registration_and_signed_stake_use_same_public_registry(monkeypatch):
    req = request("sigil-q5x4.vercel.app")
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(crypto, "get_private_key", lambda: private_key)
    monkeypatch.setattr(register, "verify_client_signature", lambda *args: None)
    monkeypatch.setattr(register, "fingerprint_from_pem", lambda *args: "fingerprint")
    monkeypatch.setattr(stake, "verify_client_signature", lambda *args: None)
    expiry = datetime.now(timezone.utc) + timedelta(minutes=1)
    conn = AsyncMock()
    connection = AsyncMock()
    connection.__aenter__.return_value = conn

    class Pool:
        def connection(self):
            return connection

    monkeypatch.setattr(register, "get_pool", Pool)
    monkeypatch.setattr(stake, "get_pool", Pool)

    # Registration consumes its nonce and finds no existing handle.
    conn.execute.side_effect = [AsyncMock(fetchone=AsyncMock(return_value=("fingerprint", expiry))), AsyncMock(fetchone=AsyncMock(return_value=None)), AsyncMock()]
    result = await register.register(register.RegisterRequest(public_key="public key", user_tag="wizzygeek2", nonce="nonce", signature="signature"), req)
    assert result.handle == "@wizzygeek2@sigil-q5x4.vercel.app"

    # A subsequent stake must encode the very same registry identity.
    conn.execute.side_effect = [AsyncMock(fetchone=AsyncMock(return_value=(expiry,))), AsyncMock(fetchone=AsyncMock(return_value=("public key", "wizzygeek2", "WizzyGeek2")))]
    response = await stake.issue_stake(stake.StakeRequest(fingerprint="fingerprint", nonce="nonce", signature="signature"), req)
    payload, signature = response.stake
    assert f"{payload['user_tag']}@{payload['iss']}" == result.handle
    private_key.public_key().verify(base64.b64decode(signature), json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(), padding.PKCS1v15(), hashes.SHA256())


@pytest.mark.parametrize("has_request", [True, False])
def test_configured_fallback_for_calls_without_host(monkeypatch, has_request):
    monkeypatch.setattr(settings, "registry_domain", " fallback.example.org ")
    hostless = Request({"type": "http", "method": "POST", "scheme": "http", "path": "/", "headers": [], "server": ("internal", 8000)})
    assert registry_domain(hostless if has_request else None) == "fallback.example.org"


def test_missing_host_and_fallback_fail_explicitly(monkeypatch):
    monkeypatch.setattr(settings, "registry_domain", "")
    with pytest.raises(HTTPException) as error:
        registry_domain()
    assert error.value.status_code == 400


def test_unicode_display_names_sign_the_same_canonical_bytes_as_clients(monkeypatch):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(crypto, "get_private_key", lambda: private_key)
    frame = crypto.mint_stake("alice", "public key", "Café <&> 😀\u2028name", registry_domain="registry.example")
    payload, signature = frame
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029").encode()
    private_key.public_key().verify(base64.b64decode(signature), canonical, padding.PKCS1v15(), hashes.SHA256())
