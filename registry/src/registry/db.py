from psycopg_pool import AsyncConnectionPool
from .config import settings

_pool: AsyncConnectionPool | None = None


async def init_pool() -> None:
    global _pool
    _pool = AsyncConnectionPool(conninfo=settings.database_url, open=False)
    await _pool.open()


async def close_pool() -> None:
    if _pool:
        await _pool.close()


def get_pool() -> AsyncConnectionPool:
    assert _pool is not None, "DB pool not initialised — call init_pool() first"
    return _pool
