"""Key and handle lookup endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..db import get_pool

router = APIRouter()


class KeyResponse(BaseModel):
    fingerprint: str
    public_key: str
    user_tag: str
    display_name: str | None


class HandleResponse(BaseModel):
    fingerprint: str
    user_tag: str
    display_name: str | None


@router.get("/registry/public-key")
async def registry_public_key() -> dict:
    return {"public_key": settings.registry_public_key_pem.replace("\\n", "\n")}


@router.get("/key/{fingerprint}", response_model=KeyResponse)
async def get_key(fingerprint: str) -> KeyResponse:
    pool = get_pool()
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT fingerprint, public_key, user_tag, display_name FROM key_registry WHERE fingerprint = %s",
            (fingerprint,),
        )).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Fingerprint not found")

    return KeyResponse(fingerprint=row[0], public_key=row[1], user_tag=row[2], display_name=row[3])


@router.get("/handle/{user_tag}", response_model=HandleResponse)
async def get_handle(user_tag: str) -> HandleResponse:
    pool = get_pool()
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT fingerprint, user_tag, display_name FROM key_registry WHERE user_tag = %s",
            (user_tag,),
        )).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Handle not found")

    return HandleResponse(fingerprint=row[0], user_tag=row[1], display_name=row[2])
