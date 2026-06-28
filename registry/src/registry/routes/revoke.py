"""Key revocation: immediate (signed) and email-recovery paths."""

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..auth import verify_client_signature
from ..db import get_pool

router = APIRouter()


class RevokeRequest(BaseModel):
    fingerprint: str
    nonce: str
    signature: str


class RevokeEmailInitRequest(BaseModel):
    recovery_email_hash: str


class RevokeEmailConfirmRequest(BaseModel):
    token: str


# In-memory pending revocations (swap for DB table in production)
_pending_revocations: dict[str, tuple[str, datetime]] = {}


@router.post("/revoke")
async def revoke_key(body: RevokeRequest) -> dict:
    pool = get_pool()

    async with pool.connection() as conn:
        row = await conn.execute(
            "DELETE FROM nonces WHERE nonce = %s AND fingerprint = %s RETURNING expires_at",
            (body.nonce, body.fingerprint),
        )
        record = await row.fetchone()
        if record is None:
            raise HTTPException(status_code=400, detail="Invalid or expired nonce")

        (expires_at,) = record
        if expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Nonce expired")

        identity = await (await conn.execute(
            "SELECT public_key FROM key_registry WHERE fingerprint = %s",
            (body.fingerprint,),
        )).fetchone()
        if identity is None:
            raise HTTPException(status_code=404, detail="Fingerprint not found")

        verify_client_signature(identity[0], body.nonce, body.signature)

        await conn.execute(
            "DELETE FROM key_registry WHERE fingerprint = %s", (body.fingerprint,)
        )

    return {"revoked": True}


@router.post("/revoke/email-init")
async def revoke_email_init(body: RevokeEmailInitRequest) -> dict:
    """Start an email-recovery revocation by looking up the email hash."""
    pool = get_pool()
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT fingerprint FROM recovery_hints WHERE email_hash = %s",
            (body.recovery_email_hash,),
        )).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="No identity found for that email")

    token = str(uuid.uuid4())
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    _pending_revocations[token] = (row[0], expires_at)

    # In production: send email with token link
    return {"message": "Revocation email sent", "debug_token": token}


@router.post("/revoke/email-confirm")
async def revoke_email_confirm(body: RevokeEmailConfirmRequest) -> dict:
    entry = _pending_revocations.pop(body.token, None)
    if entry is None:
        raise HTTPException(status_code=400, detail="Invalid or expired token")

    fingerprint, expires_at = entry
    if expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Token expired")

    pool = get_pool()
    async with pool.connection() as conn:
        await conn.execute(
            "DELETE FROM key_registry WHERE fingerprint = %s", (fingerprint,)
        )

    return {"revoked": True, "fingerprint": fingerprint}
