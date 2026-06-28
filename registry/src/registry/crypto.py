"""Registry RSA key management and stake frame minting."""

import base64
import json
import time
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey, RSAPublicKey

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


def mint_stake(user_tag: str, public_key_pem: str, display_name: str | None = None) -> list:
    """Issue a signed stake frame [payload, sig_b64] for a registered identity.

    Signing input: canonical JSON (keys sorted, no whitespace) of the payload.
    Signature: RSA-PKCS1v15 SHA-256, standard base64-encoded.

    Fields omitted intentionally:
      - sub/fingerprint: computable by SHA256-ing public_key SPKI bytes
      - exp: stake is a historical notarization, not an access token (no expiry per spec)
    """
    payload = {
        "display_name": display_name,
        "iat": int(time.time()),
        "iss": settings.registry_domain,
        "public_key": public_key_pem,
        "user_tag": f"@{user_tag}",
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    sig_bytes = get_private_key().sign(canonical, padding.PKCS1v15(), hashes.SHA256())
    sig_b64 = base64.b64encode(sig_bytes).decode()
    return [payload, sig_b64]
