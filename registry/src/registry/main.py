import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from .config import settings
from .proxy import ForwardedHostMiddleware

from .discovery_maintenance import run_discovery_maintenance
from .db import init_pool, close_pool
from .routes import challenge, register, stake, lookup, rotate, revoke, discovery


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_pool()
    task = asyncio.create_task(run_discovery_maintenance(), name='discovery-maintenance') if settings.discovery_recheck_interval_seconds else None
    try:
        yield
    finally:
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await close_pool()


app = FastAPI(title="Sigil Registry", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Preserve the socket peer until host forwarding has been checked. Run Uvicorn
# with --no-proxy-headers so its outer middleware does not rewrite it first.
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=settings.forwarded_allow_ips)
app.add_middleware(ForwardedHostMiddleware, trusted_proxies=settings.forwarded_allow_ips)

app.include_router(challenge.router)
app.include_router(register.router)
app.include_router(stake.router)
app.include_router(lookup.router)
app.include_router(rotate.router)
app.include_router(revoke.router)

app.include_router(discovery.router)
