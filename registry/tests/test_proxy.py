import httpx
import pytest
from fastapi import FastAPI, Request
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from registry.config import settings
from registry.domain import registry_domain
from registry.proxy import ForwardedHostMiddleware


def app():
    api = FastAPI()
    api.add_middleware(ProxyHeadersMiddleware, trusted_hosts="10.0.0.0/8")
    api.add_middleware(ForwardedHostMiddleware, trusted_proxies="10.0.0.0/8")

    @api.get("/")
    async def inspect(request: Request):
        return {"domain": registry_domain(request), "scheme": request.url.scheme}

    return api


@pytest.mark.asyncio
@pytest.mark.parametrize("headers,expected", [
    ({"host": "sigil-q5x4.vercel.app"}, "sigil-q5x4.vercel.app"),
    ({"x-forwarded-host": "sigil-q5x4.vercel.app", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.1"}, "sigil-q5x4.vercel.app"),
    ({"forwarded": 'for=203.0.113.1;host="sigil-q5x4.vercel.app";proto=https'}, "sigil-q5x4.vercel.app"),
    ({"x-forwarded-host": "spoofed.example, registry.example:8443"}, "registry.example:8443"),
    ({"origin": "https://client.example"}, "internal:8000"),
])
async def test_public_registry_host_through_trusted_proxy(monkeypatch, headers, expected):
    monkeypatch.setattr(settings, "registry_domain", "fallback.example.org")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app(), client=("10.0.0.2", 1234)), base_url="http://internal:8000") as client:
        response = await client.get("/", headers=headers)
    assert response.status_code == 200
    assert response.json()["domain"] == expected
    if "x-forwarded-proto" in headers:
        assert response.json()["scheme"] == "https"


@pytest.mark.asyncio
async def test_untrusted_forwarding_headers_do_not_change_issuer():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app(), client=("203.0.113.2", 1234)), base_url="http://internal:8000") as client:
        response = await client.get("/", headers={"x-forwarded-host": "spoofed.example", "x-forwarded-proto": "https", "forwarded": "host=also-spoofed.example"})
    assert response.json() == {"domain": "internal:8000", "scheme": "http"}


@pytest.mark.asyncio
@pytest.mark.parametrize("host", ["https://wrong.example", "wrong.example/path", "user@wrong.example", "wrong.example:99999"])
async def test_malformed_forwarded_host_is_rejected(host):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app(), client=("10.0.0.2", 1234)), base_url="http://internal:8000") as client:
        response = await client.get("/", headers={"x-forwarded-host": host})
    assert response.status_code == 400
