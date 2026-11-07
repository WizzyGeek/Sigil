"""Advertise known endpoints and search the registry's verified public-service directory."""
import asyncio
import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..endpoint_probe import probe_endpoint
from ..auth import verify_client_signature
from ..db import get_pool
from ..discovery import normalize_endpoint, similarity, search_text, like_pattern

router = APIRouter()


class AdvertiseRequest(BaseModel):
    fingerprint: str = Field(max_length=128)
    nonce: str = Field(max_length=128)
    signature: str = Field(max_length=2048)
    registries: list[str] = Field(default_factory=list, max_length=100)
    brokers: list[str] = Field(default_factory=list, max_length=100)


@router.post('/discovery/advertise')
async def advertise(body: AdvertiseRequest) -> dict:
    # Sign exactly the submitted values; normalize only after verifying their binding.
    payload = {"fingerprint": body.fingerprint, "nonce": body.nonce, "registries": body.registries, "brokers": body.brokers}
    signed = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    try:
        entries = {(kind, normalize_endpoint(url, kind)) for kind, values in [('registry', body.registries), ('broker', body.brokers)] for url in values}
    except (ValueError, UnicodeError) as error:
        raise HTTPException(status_code=422, detail=str(error))
    if len(entries) > 8:
        raise HTTPException(status_code=422, detail='Advertise at most 8 endpoints per request')
    if not entries:
        return {"advertised": 0, "accepted": [], "rejected": []}
    async with get_pool().connection() as conn:
        nonce = await (await conn.execute(
            'DELETE FROM nonces WHERE nonce = %s AND fingerprint = %s RETURNING expires_at',
            (body.nonce, body.fingerprint),
        )).fetchone()
        if nonce is None or nonce[0] < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail='Invalid or expired nonce')
        identity = await (await conn.execute('SELECT public_key FROM key_registry WHERE fingerprint = %s', (body.fingerprint,))).fetchone()
        if identity is None:
            raise HTTPException(status_code=404, detail='Identity is not registered here')
        verify_client_signature(identity[0], signed, body.signature)
    # Never hold a database connection while probing an untrusted remote service.
    ordered = sorted(entries)
    checked_after = datetime.now(timezone.utc)
    results = await asyncio.gather(*(probe_endpoint(url, kind) for kind, url in ordered))
    accepted = [entry for entry, result in zip(ordered, results) if result[0]]
    rejected = [{"kind": kind, "url": url, "reason": result[1]} for (kind, url), result in zip(ordered, results) if not result[0]]
    if rejected:
        async with get_pool().connection() as conn:
            async with conn.cursor() as cursor:
                await cursor.executemany(
                    'DELETE FROM endpoint_advertisements WHERE kind = %s AND url = %s AND verified_at <= %s',
                    [(entry['kind'], entry['url'], checked_after) for entry in rejected],
                )
    if accepted:
        async with get_pool().connection() as conn:
            async with conn.cursor() as cursor:
                await cursor.executemany(
                    'INSERT INTO endpoint_advertisements (kind, url, verified_at) VALUES (%s, %s, NOW()) ON CONFLICT (kind, url) DO UPDATE SET last_seen_at = NOW(), verified_at = NOW()',
                    accepted,
                )
    return {"advertised": len(accepted), "accepted": [{"kind": kind, "url": url} for kind, url in accepted], "rejected": rejected}


@router.get('/discovery')
async def discover(kind: Literal['registry', 'broker'], query: str = Query('', max_length=200), limit: int = Query(8, ge=1, le=20)) -> dict:
    text = search_text(query)
    # Exact/substring candidates first; bounded trigram candidates provide typo matches
    # without requiring a PostgreSQL extension or loading the entire directory.
    grams = list(dict.fromkeys(text[i:i + 3] for i in range(max(0, len(text) - 2))))[:64]
    patterns = [like_pattern(gram) for gram in grams]
    async with get_pool().connection() as conn:
        if not text:
            rows = await (await conn.execute(
                'SELECT url FROM endpoint_advertisements WHERE kind = %s AND verified_at IS NOT NULL ORDER BY last_seen_at DESC, url LIMIT %s', (kind, limit),
            )).fetchall()
        else:
            rows = await (await conn.execute(
                "WITH candidates AS (SELECT url, rtrim(regexp_replace(lower(url), '^[a-z]+://', ''), '/') AS target FROM endpoint_advertisements WHERE kind = %s AND verified_at IS NOT NULL) SELECT url FROM candidates WHERE target LIKE %s OR target LIKE ANY(%s) ORDER BY CASE WHEN target = %s THEN 0 WHEN target LIKE %s THEN 1 WHEN target LIKE %s THEN 2 ELSE 3 END, length(target), url LIMIT 512",
                (kind, like_pattern(text), patterns, text, like_pattern(text)[1:], like_pattern(text)),
            )).fetchall()
    urls = [row[0] for row in rows]
    if text:
        urls.sort(key=lambda url: similarity(url, text))
    return {"entries": [{"kind": kind, "url": url} for url in urls[:limit]]}
