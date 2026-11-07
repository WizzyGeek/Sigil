"""Bounded, DNS-pinned public-service admission checks (no redirects or proxies)."""
import asyncio
import base64
import hashlib
import ipaddress
import json
import os
import socket
import ssl
from urllib.parse import quote, urlsplit

import h11
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key

PROBE_TIMEOUT = 4
MAX_RESPONSE_BYTES = 65536
_slots = asyncio.Semaphore(8)
# Cover newer IANA classifications not present in every supported Python 3.11 build.
# https://www.iana.org/assignments/iana-ipv6-special-registry/
_V6_SPECIAL = ipaddress.ip_network('2001::/23')
_V6_GLOBAL_EXCEPTIONS = tuple(ipaddress.ip_network(value) for value in (
    '2001:1::1/128', '2001:1::2/128', '2001:1::3/128', '2001:3::/32',
    '2001:4:112::/48', '2001:20::/28', '2001:30::/28',
))
_V6_DENIED = tuple(ipaddress.ip_network(value) for value in (
    '64:ff9b::/96', '64:ff9b:1::/48', '3fff::/20', '5f00::/16', '100:0:0:1::/64',
))
_V4_SPECIAL = ipaddress.ip_network('192.0.0.0/24')
_V4_DEPRECATED = ipaddress.ip_network('192.88.99.0/24')


class ProbeFailure(ValueError):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
        if isinstance(address, ipaddress.IPv4Address):
            # https://www.iana.org/assignments/iana-ipv4-special-registry/
            if address in _V4_SPECIAL and str(address) not in ('192.0.0.9', '192.0.0.10'):
                return False
            if address in _V4_DEPRECATED:
                return False
        if isinstance(address, ipaddress.IPv6Address):
            if any(address in network for network in _V6_DENIED):
                return False
            if address in _V6_SPECIAL and not any(address in network for network in _V6_GLOBAL_EXCEPTIONS):
                return False
        if not address.is_global or address.is_multicast or address.is_reserved or address.is_unspecified:
            return False
        if isinstance(address, ipaddress.IPv6Address) and (address.ipv4_mapped or address.sixtofour or address.teredo):
            return False
        return True
    except ValueError:
        return False


async def resolve_public(host: str, port: int) -> list[str]:
    name = host.lower().rstrip('.')
    if name == 'localhost' or name.endswith(('.localhost', '.local', '.internal', '.home.arpa')) or '%' in name:
        raise ProbeFailure('not_public')
    try:
        literal = ipaddress.ip_address(name)
    except ValueError:
        literal = None
    if literal is not None:
        if not public_ip(str(literal)):
            raise ProbeFailure('not_public')
        return [str(literal)]
    addresses = await asyncio.get_running_loop().getaddrinfo(name, port, type=socket.SOCK_STREAM)
    ips = list(dict.fromkeys(row[4][0] for row in addresses))
    # Reject mixed public/private answers as well as wholly private DNS.
    if not ips or any(not public_ip(ip) for ip in ips):
        raise ProbeFailure('not_public')
    return ips


async def exchange(url: str, kind: str, ip: str) -> bool:
    parsed = urlsplit(url)
    tls = parsed.scheme in ('https', 'wss')
    port = parsed.port or (443 if tls else 80)
    context = ssl.create_default_context() if tls else None
    # Connect to the checked numeric address. TLS SNI/certificate checks and Host
    # still use the original hostname; DNS is never re-resolved by the connection.
    reader, writer = await asyncio.wait_for(asyncio.open_connection(
        host=ip, port=port, ssl=context, server_hostname=parsed.hostname if tls else None,
    ), timeout=2)
    try:
        target = parsed.path or '/'
        if kind == 'registry':
            target = target.rstrip('/') + '/registry/public-key'
        target = quote(target, safe="/%:@!$&'()*+,;=-._~")
        headers = [(b'Host', parsed.netloc.encode('ascii')), (b'User-Agent', b'Sigil-Discovery/1')]
        websocket_key = base64.b64encode(os.urandom(16))
        if kind == 'broker':
            headers += [(b'Upgrade', b'websocket'), (b'Connection', b'Upgrade'), (b'Sec-WebSocket-Key', websocket_key), (b'Sec-WebSocket-Version', b'13')]
        else:
            headers += [(b'Connection', b'close'), (b'Accept', b'application/json')]
        protocol = h11.Connection(h11.CLIENT, max_incomplete_event_size=16384)
        writer.write(protocol.send(h11.Request(method=b'GET', target=target.encode('ascii'), headers=headers)))
        writer.write(protocol.send(h11.EndOfMessage()))
        await writer.drain()
        body = bytearray()
        valid_response = False
        while True:
            event = protocol.next_event()
            if event is h11.NEED_DATA:
                chunk = await reader.read(8192)
                protocol.receive_data(chunk)
                if not chunk and not valid_response:
                    return False
            elif isinstance(event, h11.InformationalResponse):
                if event.status_code != 101:
                    continue
                if kind != 'broker':
                    return False
                response_headers = dict(event.headers)
                expected = base64.b64encode(hashlib.sha1(websocket_key + b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
                return (response_headers.get(b'upgrade', b'').lower() == b'websocket'
                        and b'upgrade' in [item.strip().lower() for item in response_headers.get(b'connection', b'').split(b',')]
                        and response_headers.get(b'sec-websocket-accept') == expected)
            elif isinstance(event, h11.Response):
                if kind != 'registry' or event.status_code != 200:
                    return False  # Includes all redirects.
                valid_response = True
            elif isinstance(event, h11.Data):
                body.extend(event.data)
                if len(body) > MAX_RESPONSE_BYTES:
                    return False
            elif isinstance(event, h11.EndOfMessage):
                if not valid_response:
                    return False
                data = json.loads(body)
                key = load_pem_public_key(data['public_key'].encode('ascii'))
                return isinstance(key, RSAPublicKey) and key.key_size >= 2048
            elif isinstance(event, h11.ConnectionClosed):
                return False
    finally:
        writer.close()
        try:
            await asyncio.wait_for(writer.wait_closed(), timeout=0.5)
        except (TimeoutError, OSError, ssl.SSLError):
            pass


async def probe_endpoint(url: str, kind: str) -> tuple[bool, str]:
    try:
        # Queueing, DNS, connection and response all share the same deadline.
        async with asyncio.timeout(PROBE_TIMEOUT):
            async with _slots:
                parsed = urlsplit(url)
                if kind == 'registry' and parsed.scheme != 'https':
                    raise ProbeFailure('not_public')
                ips = await resolve_public(parsed.hostname or '', parsed.port or (443 if parsed.scheme in ('https', 'wss') else 80))
                for ip in ips[:4]:
                    try:
                        if await exchange(url, kind, ip):
                            return True, ''
                    except ssl.SSLCertVerificationError:
                        return False, 'invalid_tls'
                    except (OSError, ValueError, KeyError, TypeError, h11.ProtocolError, TimeoutError):
                        continue
                return False, 'not_responding_service'
    except ProbeFailure as error:
        return False, error.reason
    except (OSError, ValueError, TimeoutError):
        return False, 'unreachable'
