"""POST /stake — issue a signed stake JWT for a registered identity."""

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..auth import verify_client_signature
from ..crypto import mint_stake
from ..db import get_pool

router = APIRouter()


class StakeRequest(BaseModel):
    fingerprint: str
    nonce: str
    signature: str


class StakeResponse(BaseModel):
    stake: str


@router.post("/stake", response_model=StakeResponse)
async def issue_stake(body: StakeRequest) -> StakeResponse:
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
            "SELECT public_key, user_tag FROM key_registry WHERE fingerprint = %s",
            (body.fingerprint,),
        )).fetchone()
        if identity is None:
            raise HTTPException(status_code=404, detail="Fingerprint not registered")

        public_key_pem, user_tag = identity
        verify_client_signature(public_key_pem, body.nonce, body.signature)

    token = mint_stake(body.fingerprint, user_tag)
    return StakeResponse(stake=token)
