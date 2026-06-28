"""Registry RSA key management and JWT minting."""

import time
import uuid
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey, RSAPublicKey
import jwt

from .config import settings


def _load_private_key() -> RSAPrivateKey:
    pem = settings.registry_private_key_pem.replace("\\n", "\n").encode()
    return serialization.load_pem_private_key(pem, password=None)  # type: ignore[return-value]


def _load_public_key() -> RSAPublicKey:
    pem = settings.registry_public_key_pem.replace("\\n", "\n").encode()
    return serialization.load_pem_public_key(pem)  # type: ignore[return-value]


_private_key: RSAPrivateKey | None = None
_public_key: RSAPublicKey | None = None


def get_private_key() -> RSAPrivateKey:
    global _private_key
    if _private_key is None:
        _private_key = _load_private_key()
    return _private_key


def get_public_key() -> RSAPublicKey:
    global _public_key
    if _public_key is None:
        _public_key = _load_public_key()
    return _public_key


def mint_stake(fingerprint: str, user_tag: str, ttl_seconds: int = 86400 * 30) -> str:
    """Issue a signed stake JWT for a registered identity."""
    now = int(time.time())
    payload = {
        "iss": settings.registry_domain,
        "sub": fingerprint,
        "handle": f"@{user_tag}@{settings.registry_domain}",
        "iat": now,
        "exp": now + ttl_seconds,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, get_private_key(), algorithm="RS256")


def verify_stake(token: str) -> dict:
    """Verify a stake JWT and return its claims."""
    return jwt.decode(token, get_public_key(), algorithms=["RS256"])
