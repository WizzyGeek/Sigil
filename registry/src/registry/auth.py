"""Nonce verification and client signature checking."""

import base64
import hashlib
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import (
    load_pem_public_key,
    Encoding,
    PublicFormat,
)
from fastapi import HTTPException


def verify_client_signature(
    public_key_pem: str,
    nonce: str,
    signature_b64: str,
) -> None:
    """Verify that the client signed the nonce with the private key matching public_key_pem.

    Raises HTTPException(401) on failure.
    """
    try:
        pub = load_pem_public_key(public_key_pem.encode())
        sig = base64.b64decode(signature_b64)
        pub.verify(sig, nonce.encode(), padding.PKCS1v15(), hashes.SHA256())  # type: ignore[arg-type]
    except Exception:
        raise HTTPException(status_code=401, detail="Signature verification failed")


def fingerprint_from_pem(public_key_pem: str) -> str:
    """Derive the SHA-256 fingerprint of a public key's SPKI DER bytes, hex-encoded."""
    pub = load_pem_public_key(public_key_pem.strip().encode())
    der = pub.public_bytes(encoding=Encoding.DER, format=PublicFormat.SubjectPublicKeyInfo)  # type: ignore[arg-type]
    return hashlib.sha256(der).hexdigest()
