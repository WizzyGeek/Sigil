"""POST /register — register a new identity."""

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import verify_client_signature, fingerprint_from_pem
from ..db import get_pool
from ..domain import registry_domain

router = APIRouter()


class RegisterRequest(BaseModel):
    public_key: str
    user_tag: str
    display_name: str | None = None
    nonce: str
    signature: str
    recovery_email_hash: str | None = None


class RegisterResponse(BaseModel):
    fingerprint: str
    handle: str


@router.post("/register", response_model=RegisterResponse)
async def register(body: RegisterRequest, request: Request) -> RegisterResponse:
    pool = get_pool()

    async with pool.connection() as conn:
        # Consume and validate nonce
        row = await conn.execute(
            "DELETE FROM nonces WHERE nonce = %s RETURNING fingerprint, expires_at",
            (body.nonce,),
        )
        record = await row.fetchone()
        if record is None:
            raise HTTPException(status_code=400, detail="Invalid or expired nonce")

        _, expires_at = record
        if expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Nonce expired")

        verify_client_signature(body.public_key, body.nonce, body.signature)

        fp = fingerprint_from_pem(body.public_key)

        # Check handle availability
        existing = await (await conn.execute(
            "SELECT 1 FROM key_registry WHERE user_tag = %s", (body.user_tag,)
        )).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Handle already taken")

        await conn.execute(
            """
            INSERT INTO key_registry (fingerprint, public_key, user_tag, display_name)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (fingerprint) DO NOTHING
            """,
            (fp, body.public_key, body.user_tag, body.display_name),
        )

        if body.recovery_email_hash:
            await conn.execute(
                """
                INSERT INTO recovery_hints (fingerprint, email_hash)
                VALUES (%s, %s)
                ON CONFLICT (fingerprint) DO UPDATE SET email_hash = EXCLUDED.email_hash
                """,
                (fp, body.recovery_email_hash),
            )

    return RegisterResponse(fingerprint=fp, handle=f"@{body.user_tag}@{registry_domain(request)}")
