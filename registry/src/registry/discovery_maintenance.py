"""Small random health sweeps, coordinated across registry workers via PostgreSQL."""
import asyncio
import logging
import math
import uuid

from .config import settings
from .db import get_pool
from .endpoint_probe import PROBE_TIMEOUT, probe_endpoint

log = logging.getLogger(__name__)


async def sweep_once() -> bool:
    """Claim a due sweep; return False if another worker owns it or it is not due."""
    interval = settings.discovery_recheck_interval_seconds
    if not interval:
        return False
    size = settings.discovery_recheck_sample_size
    token = str(uuid.uuid4())
    lease_seconds = math.ceil(size / 8) * PROBE_TIMEOUT + 60
    async with get_pool().connection() as conn:
        claim = await (await conn.execute(
            "UPDATE discovery_maintenance SET next_run_at = NOW() + (%s * INTERVAL '1 second'), lease_until = NOW() + (%s * INTERVAL '1 second'), lease_token = %s WHERE singleton = TRUE AND next_run_at <= NOW() AND lease_until <= NOW() RETURNING singleton",
            (interval, lease_seconds, token),
        )).fetchone()
    if claim is None:
        return False
    succeeded = False
    try:
        async with asyncio.timeout(lease_seconds - 10):
            async with get_pool().connection() as conn:
                rows = await (await conn.execute(
                    'SELECT kind, url, verified_at FROM endpoint_advertisements WHERE verified_at IS NOT NULL ORDER BY RANDOM() LIMIT %s',
                    (size,),
                )).fetchall()
            healthy_count = failed_count = 0
            # Bound background concurrency and avoid leaving hundreds of probes queued.
            for offset in range(0, len(rows), 8):
                batch = rows[offset:offset + 8]
                results = await asyncio.gather(*(probe_endpoint(url, kind) for kind, url, _verified in batch))
                healthy = [(kind, url, verified) for (kind, url, verified), result in zip(batch, results) if result[0]]
                failed = [(kind, url, verified) for (kind, url, verified), result in zip(batch, results) if not result[0]]
                async with get_pool().connection() as conn:
                    async with conn.cursor() as cursor:
                        if healthy:
                            await cursor.executemany(
                                'UPDATE endpoint_advertisements SET verified_at = NOW() WHERE kind = %s AND url = %s AND verified_at = %s', healthy,
                            )
                        if failed:
                            # A newer successful advertisement/check wins over this old sample.
                            await cursor.executemany(
                                'DELETE FROM endpoint_advertisements WHERE kind = %s AND url = %s AND verified_at = %s', failed,
                            )
                healthy_count += len(healthy)
                failed_count += len(failed)
            succeeded = True
            log.info('Discovery sweep checked %d advertisements: %d healthy, %d failed', len(rows), healthy_count, failed_count)
    finally:
        try:
            async with asyncio.timeout(5):
                async with get_pool().connection() as conn:
                    await conn.execute(
                        "UPDATE discovery_maintenance SET lease_until = '-infinity', lease_token = NULL, next_run_at = CASE WHEN %s THEN next_run_at ELSE LEAST(next_run_at, NOW() + INTERVAL '60 seconds') END WHERE singleton = TRUE AND lease_token = %s",
                        (succeeded, token),
                    )
        except Exception:
            # The lease expires on its own. Never hide a cancellation or the
            # original sweep failure behind a database cleanup failure.
            log.exception('Could not release discovery sweep lease; it will expire')
    return True


async def run_discovery_maintenance() -> None:
    while True:
        try:
            await sweep_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            # A failed sweep must not stop future checks or the registry's API.
            log.exception('Discovery advertisement sweep failed; will retry')
        await asyncio.sleep(min(60, settings.discovery_recheck_interval_seconds or 60))
