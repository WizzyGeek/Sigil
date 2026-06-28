"""Key rotation: POST /rotate/challenge, POST /rotate."""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..auth import verify_client_signature, fingerprint_from_pem
from ..db import get_pool

router = APIRouter()

NONCE_TTL_SECONDS = 300


class RotateChallengeRequest(BaseModel):
    fingerprint: str


class RotateChallengeResponse(BaseModel):
    nonce: str
    expires_at: str


class RotateRequest(BaseModel):
    old_fingerprint: str
    new_public_key: str
    nonce: str
    old_signature: str
    new_signature: str


class RotateResponse(BaseModel):
    new_fingerprint: str


@router.post("/rotate/challenge", response_model=RotateChallengeResponse)
async def rotate_challenge(body: RotateChallengeRequest) -> RotateChallengeResponse:
    pool = get_pool()
    async with pool.connection() as conn:
        exists = await (await conn.execute(
            "SELECT 1 FROM key_registry WHERE fingerprint = %s", (body.fingerprint,)
        )).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Fingerprint not found")

    nonce = str(uuid.uuid4())
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=NONCE_TTL_SECONDS)

    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO nonces (nonce, fingerprint, expires_at) VALUES (%s, %s, %s)",
            (nonce, body.fingerprint, expires_at),
        )

    return RotateChallengeResponse(nonce=nonce, expires_at=expires_at.isoformat())


@router.post("/rotate", response_model=RotateResponse)
async def rotate_key(body: RotateRequest) -> RotateResponse:
    pool = get_pool()

    async with pool.connection() as conn:
        row = await conn.execute(
            "DELETE FROM nonces WHERE nonce = %s AND fingerprint = %s RETURNING expires_at",
            (body.nonce, body.old_fingerprint),
        )
        record = await row.fetchone()
        if record is None:
            raise HTTPException(status_code=400, detail="Invalid or expired nonce")

        (expires_at,) = record
        if expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Nonce expired")

        identity = await (await conn.execute(
            "SELECT public_key, user_tag, display_name FROM key_registry WHERE fingerprint = %s",
            (body.old_fingerprint,),
        )).fetchone()
        if identity is None:
            raise HTTPException(status_code=404, detail="Identity not found")

        old_public_key, user_tag, display_name = identity

        verify_client_signature(old_public_key, body.nonce, body.old_signature)
        verify_client_signature(body.new_public_key, body.nonce, body.new_signature)

        new_fp = fingerprint_from_pem(body.new_public_key)

        await conn.execute(
            "DELETE FROM key_registry WHERE fingerprint = %s", (body.old_fingerprint,)
        )
        await conn.execute(
            "INSERT INTO key_registry (fingerprint, public_key, user_tag, display_name) VALUES (%s, %s, %s, %s)",
            (new_fp, body.new_public_key, user_tag, display_name),
        )

    return RotateResponse(new_fingerprint=new_fp)
