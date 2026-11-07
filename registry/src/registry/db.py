from psycopg_pool import AsyncConnectionPool
from .config import settings
from .discovery import SCHEMA as DISCOVERY_SCHEMA

_pool: AsyncConnectionPool | None = None


async def init_pool() -> None:
    global _pool
    _pool = AsyncConnectionPool(conninfo=settings.database_url, open=False)
    await _pool.open()
    # Idempotent migration also runs for existing volumes and production databases.
    async with _pool.connection() as conn:
        await conn.execute('SELECT pg_advisory_xact_lock(736445912)')
        await conn.execute(DISCOVERY_SCHEMA)


async def close_pool() -> None:
    if _pool:
        await _pool.close()


def get_pool() -> AsyncConnectionPool:
    assert _pool is not None, "DB pool not initialised — call init_pool() first"
    return _pool
