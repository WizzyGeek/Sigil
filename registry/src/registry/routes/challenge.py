"""POST /challenge — issue a nonce for a given fingerprint."""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import get_pool

router = APIRouter()

NONCE_TTL_SECONDS = 300


class ChallengeRequest(BaseModel):
    fingerprint: str


class ChallengeResponse(BaseModel):
    nonce: str
    expires_at: str


@router.post("/challenge", response_model=ChallengeResponse)
async def issue_challenge(body: ChallengeRequest) -> ChallengeResponse:
    nonce = str(uuid.uuid4())
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=NONCE_TTL_SECONDS)

    pool = get_pool()
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO nonces (nonce, fingerprint, expires_at) VALUES (%s, %s, %s)",
            (nonce, body.fingerprint, expires_at),
        )

    return ChallengeResponse(nonce=nonce, expires_at=expires_at.isoformat())
