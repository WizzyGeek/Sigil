import asyncio
import base64
import hashlib
import json
import ssl
from unittest.mock import AsyncMock

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from registry import endpoint_probe as probe


@pytest.mark.parametrize('address', ['127.0.0.1','10.0.0.1','192.168.0.1','172.16.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','192.0.2.1','198.51.100.1','203.0.113.1','::1','::','fe80::1','fc00::1','2001:db8::1','::ffff:127.0.0.1','2002:7f00:1::','192.0.0.8','192.88.99.2','2001:2::1','2001:5::1','3fff::1','64:ff9b::7f00:1'])
def test_nonpublic_addresses_are_never_probe_targets(address):
    assert not probe.public_ip(address)


def test_global_unicast_addresses_can_be_checked():
    assert probe.public_ip('8.8.8.8')
    assert probe.public_ip('2606:4700:4700::1111')


@pytest.mark.asyncio
async def test_local_and_mixed_dns_answers_cannot_open_a_connection(monkeypatch):
    exchange = AsyncMock()
    monkeypatch.setattr(probe, 'exchange', exchange)
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, 'getaddrinfo', AsyncMock(return_value=[(2,1,6,'',('8.8.8.8',443)),(2,1,6,'',('10.0.0.1',443))]))
    for url in ['https://localhost','https://127.0.0.1','https://mixed.example','https://localhost./','https://[::1]']:
        assert await probe.probe_endpoint(url,'registry') == (False,'not_public')
    exchange.assert_not_called()


class Writer:
    def __init__(self): self.data=bytearray();self.closed=False
    def write(self,data): self.data.extend(data)
    async def drain(self): pass
    def close(self): self.closed=True
    async def wait_closed(self): pass


def registry_body():
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048).public_key()
    return json.dumps({'public_key':key.public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo).decode()}).encode()


def response(body,status=b'200 OK'):
    return b'HTTP/1.1 '+status+b'\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'+body


@pytest.mark.asyncio
async def test_registry_probe_pins_ip_and_checks_original_tls_host_with_bounded_json(monkeypatch):
    reader=asyncio.StreamReader();reader.feed_data(response(registry_body()));reader.feed_eof()
    writer=Writer();connect=AsyncMock(return_value=(reader,writer));monkeypatch.setattr(asyncio,'open_connection',connect)
    assert await probe.exchange('https://registry.example/api','registry','8.8.8.8')
    args=connect.call_args.kwargs
    assert args['host']=='8.8.8.8'
    assert args['server_hostname']=='registry.example'
    assert args['ssl'].verify_mode==ssl.CERT_REQUIRED and args['ssl'].check_hostname
    assert b'GET /api/registry/public-key HTTP/1.1' in writer.data
    assert b'Host: registry.example' in writer.data
    assert writer.closed


@pytest.mark.asyncio
@pytest.mark.parametrize('raw', [response(b'',b'302 Found'),response(b'{"public_key":"not a key"}'),response(b'x'*65537)])
async def test_redirects_invalid_keys_and_oversized_responses_fail_closed(monkeypatch,raw):
    reader=asyncio.StreamReader();reader.feed_data(raw);reader.feed_eof();writer=Writer()
    connect=AsyncMock(return_value=(reader,writer));monkeypatch.setattr(asyncio,'open_connection',connect)
    # probe_endpoint catches protocol/JSON/key errors and rejects the advertisement.
    monkeypatch.setattr(probe,'resolve_public',AsyncMock(return_value=['8.8.8.8']))
    ok,_=await probe.probe_endpoint('https://registry.example','registry')
    assert not ok
    assert connect.call_count==1
    assert writer.closed


@pytest.mark.asyncio
async def test_chunked_registry_response_is_supported(monkeypatch):
    body=registry_body()
    reader=asyncio.StreamReader();reader.feed_data(b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'+hex(len(body))[2:].encode()+b'\r\n'+body+b'\r\n0\r\n\r\n');reader.feed_eof()
    monkeypatch.setattr(asyncio,'open_connection',AsyncMock(return_value=(reader,Writer())))
    assert await probe.exchange('https://registry.example','registry','8.8.8.8')


@pytest.mark.asyncio
@pytest.mark.parametrize('valid',[True,False])
async def test_broker_requires_a_valid_websocket_upgrade_accept(monkeypatch,valid):
    writer=Writer()
    class Reader:
        async def read(self,_size):
            headers=dict(line.split(b': ',1) for line in bytes(writer.data).split(b'\r\n')[1:] if b': ' in line)
            key=headers[b'Sec-WebSocket-Key']
            accepted=base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest()) if valid else b'wrong'
            return b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accepted+b'\r\n\r\n'
    monkeypatch.setattr(asyncio,'open_connection',AsyncMock(return_value=(Reader(),writer)))
    assert await probe.exchange('wss://broker.example/ws','broker','8.8.8.8') is valid
    assert writer.closed


@pytest.mark.asyncio
async def test_tls_and_timeouts_reject_instead_of_admitting(monkeypatch):
    monkeypatch.setattr(probe,'resolve_public',AsyncMock(return_value=['8.8.8.8']))
    monkeypatch.setattr(probe,'exchange',AsyncMock(side_effect=ssl.SSLCertVerificationError('bad certificate')))
    assert await probe.probe_endpoint('https://registry.example','registry')==(False,'invalid_tls')
    monkeypatch.setattr(probe,'PROBE_TIMEOUT',0.01)
    async def stalled(*args): await asyncio.sleep(1)
    monkeypatch.setattr(probe,'resolve_public',stalled)
    assert await probe.probe_endpoint('https://registry.example','registry')==(False,'unreachable')
