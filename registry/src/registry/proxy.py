"""Restore the public Host header before URL generation and registry signing."""

from ipaddress import ip_address, ip_network
import re
from urllib.parse import urlsplit

from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Scope, Receive, Send


class ForwardedHostMiddleware:
    def __init__(self, app: ASGIApp, trusted_proxies: str = "127.0.0.1,::1") -> None:
        self.app = app
        self.trusted = [value.strip() for value in trusted_proxies.split(",") if value.strip()]

    def _trusted_peer(self, host: str) -> bool:
        if "*" in self.trusted or host in self.trusted:
            return True
        try:
            address = ip_address(host)
            return any(address in ip_network(value, strict=False) for value in self.trusted)
        except ValueError:
            return False

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        peer = scope.get("client")
        if scope["type"] == "http" and peer and self._trusted_peer(peer[0]):
            headers = dict(scope["headers"])
            forwarded_host = headers.get(b"x-forwarded-host", b"").decode("latin1").split(",")[-1].strip()
            if not forwarded_host:
                # The last element belongs to the immediate, explicitly trusted proxy.
                forwarded = headers.get(b"forwarded", b"").decode("latin1").split(",")[-1]
                match = re.search(r'(?:^|;)\s*host\s*=\s*(?:"([^"\\]*)"|([^;\s]+))', forwarded, re.IGNORECASE)
                if match:
                    forwarded_host = match.group(1) or match.group(2)
            if forwarded_host:
                try:
                    parsed = urlsplit("//" + forwarded_host)
                    if re.search(r'[\s/\\@?#,;]', forwarded_host) or not parsed.hostname or parsed.path or parsed.query or parsed.fragment:
                        raise ValueError("Invalid forwarded host")
                    _ = parsed.port  # Reject malformed or out-of-range ports.
                except ValueError:
                    await PlainTextResponse("Invalid forwarded host", status_code=400)(scope, receive, send)
                    return
                scope = dict(scope)
                scope["headers"] = [(name, value) for name, value in scope["headers"] if name != b"host"] + [(b"host", forwarded_host.encode("latin1"))]
        await self.app(scope, receive, send)
