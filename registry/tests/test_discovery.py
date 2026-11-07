import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from registry.discovery import normalize_endpoint, similarity
from registry.routes import discovery


@pytest.mark.parametrize('value,kind,expected', [
    ('https://REG.test:443/api///', 'registry', 'https://reg.test/api'),
    ('wss://BROKER.test:443', 'broker', 'wss://broker.test/'),
    ('http://localhost:8000/', 'registry', 'http://localhost:8000'),
    ('http://[::1]:8000/', 'registry', 'http://[::1]:8000'),
])
def test_canonical_endpoints(value, kind, expected):
    assert normalize_endpoint(value, kind) == expected


@pytest.mark.parametrize('url,kind', [
    ('http://public.test', 'registry'), ('javascript:alert(1)', 'broker'),
    ('wss://user:password@broker.test/ws', 'broker'), ('wss://broker.test/ws?token=secret', 'broker'),
    ('https://reg.test#fragment', 'registry'), ('/ws', 'broker'), ('https://reg.test:99999', 'registry'),
])
def test_rejects_nonpublic_or_invalid_advertisements(url, kind):
    with pytest.raises(ValueError):
        normalize_endpoint(url, kind)


def connection(monkeypatch, rows):
    conn = AsyncMock()
    conn.execute.side_effect = [AsyncMock(fetchone=AsyncMock(return_value=row)) for row in rows]
    cursor = AsyncMock()
    conn.cursor.return_value = cursor
    # cursor() returns an async context manager, not a coroutine.
    conn.cursor = lambda: cursor
    manager = AsyncMock()
    manager.__aenter__.return_value = conn

    class Pool:
        def connection(self):
            return manager

    monkeypatch.setattr(discovery, 'get_pool', Pool)
    return conn, cursor.__aenter__.return_value


@pytest.mark.asyncio
async def test_signed_advertisements_bind_values_and_upsert_unique_normalized_urls(monkeypatch):
    expiry = datetime.now(timezone.utc) + timedelta(minutes=1)
    conn, cursor = connection(monkeypatch, [(expiry,), ('public key',)])
    verified = []
    monkeypatch.setattr(discovery, 'verify_client_signature', lambda *args: verified.append(args))
    body = discovery.AdvertiseRequest(fingerprint='fp', nonce='nonce', signature='signature', registries=['https://REG.test/', 'https://reg.test'], brokers=['wss://broker.test'])
    monkeypatch.setattr(discovery, 'probe_endpoint', AsyncMock(return_value=(True, '')))
    result = await discovery.advertise(body)
    assert result['advertised'] == 2
    assert result['rejected'] == []
    payload = json.loads(verified[0][1])
    assert payload == {'fingerprint':'fp','nonce':'nonce','registries':body.registries,'brokers':body.brokers}
    assert verified[0][0] == 'public key'
    args = cursor.executemany.call_args.args
    assert 'ON CONFLICT' in args[0]
    assert args[1] == [('broker', 'wss://broker.test/'), ('registry', 'https://reg.test')]
    assert conn.execute.call_args_list[0].args[1] == ('nonce', 'fp')


@pytest.mark.asyncio
async def test_expired_nonce_cannot_insert_advertisements(monkeypatch):
    conn, cursor = connection(monkeypatch, [(datetime.now(timezone.utc) - timedelta(minutes=1),)])
    body = discovery.AdvertiseRequest(fingerprint='fp', nonce='nonce', signature='signature', brokers=['wss://broker.test'])
    with pytest.raises(HTTPException) as error:
        await discovery.advertise(body)
    assert error.value.status_code == 400
    assert conn.execute.call_count == 1
    cursor.executemany.assert_not_called()


@pytest.mark.asyncio
async def test_invalid_signature_never_inserts_advertisements(monkeypatch):
    _, cursor = connection(monkeypatch, [(datetime.now(timezone.utc) + timedelta(minutes=1),), ('key',)])
    def reject(*args):
        raise HTTPException(status_code=401, detail='Invalid signature')
    monkeypatch.setattr(discovery, 'verify_client_signature', reject)
    with pytest.raises(HTTPException):
        await discovery.advertise(discovery.AdvertiseRequest(fingerprint='fp', nonce='nonce', signature='bad', brokers=['wss://broker.test']))
    cursor.executemany.assert_not_called()


def test_similarity_prefers_exact_then_prefix_then_typo_matches():
    urls=['wss://unrelated.test/ws', 'wss://alpha.test/ws', 'wss://alpha-two.test/ws', 'wss://alhpa.test/ws']
    assert sorted(urls, key=lambda url:similarity(url,'alpha'))[:2] == ['wss://alpha.test/ws','wss://alpha-two.test/ws']
    assert similarity('wss://alpha.test/ws','alhpa') < similarity('wss://unrelated.test/ws','alhpa')
