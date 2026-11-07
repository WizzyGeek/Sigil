"""Resolve the public request host, with a configured fallback for hostless calls."""

from fastapi import HTTPException, Request

from .config import settings


def registry_domain(request: Request | None = None) -> str:
    # Trusted proxy middleware restores Host before either endpoint uses it.
    # Do not substitute the ASGI server address when the request has no Host.
    if request is not None and request.headers.get("host", "").strip():
        return request.url.netloc
    if fallback := settings.registry_domain.strip():
        return fallback
    raise HTTPException(status_code=400, detail="Registry host is unavailable; provide Host or configure REGISTRY_DOMAIN as a fallback.")
