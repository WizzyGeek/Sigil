from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import init_pool, close_pool
from .routes import challenge, register, stake, lookup, rotate, revoke


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_pool()
    yield
    await close_pool()


app = FastAPI(title="Sigil Registry", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(challenge.router)
app.include_router(register.router)
app.include_router(stake.router)
app.include_router(lookup.router)
app.include_router(rotate.router)
app.include_router(revoke.router)
