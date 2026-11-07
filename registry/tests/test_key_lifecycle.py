from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from registry.routes import rotate, revoke


def setup(monkeypatch, route, rows):
    conn = AsyncMock()
    conn.execute.side_effect = [AsyncMock(fetchone=AsyncMock(return_value=row)) for row in rows]
    context = AsyncMock()
    context.__aenter__.return_value = conn

    class Pool:
        def connection(self):
            return context

    monkeypatch.setattr(route, 'get_pool', Pool)
    monkeypatch.setattr(route, 'verify_client_signature', lambda *args: None)
    return conn


def rotation():
    return rotate.RotateRequest(old_fingerprint='old', new_public_key='new pem', nonce='nonce', old_signature='old sig', new_signature='new sig')


@pytest.mark.asyncio
async def test_rotation_preserves_recovery_and_cleans_old_nonces(monkeypatch):
    expiry = datetime.now(timezone.utc) + timedelta(minutes=1)
    conn = setup(monkeypatch, rotate, [(expiry,), ('old pem', 'alice', 'Alice', 'registered date'), ('email hash',), None, None, None, None, None])
    monkeypatch.setattr(rotate, 'fingerprint_from_pem', lambda _: 'new')
    result = await rotate.rotate_key(rotation())
    assert result.new_fingerprint == 'new'
    calls = conn.execute.call_args_list
    assert 'FOR UPDATE' in calls[1].args[0]
    assert calls[5].args[1] == ('new', 'new pem', 'alice', 'Alice', 'registered date')
    assert calls[6].args[1] == ('new', 'email hash')
    assert calls[7].args == ('DELETE FROM nonces WHERE fingerprint = %s', ('old',))


@pytest.mark.asyncio
@pytest.mark.parametrize('new_fp,status', [('old', 400), ('already registered', 409)])
async def test_rotation_rejects_same_or_registered_replacement(monkeypatch, new_fp, status):
    expiry = datetime.now(timezone.utc) + timedelta(minutes=1)
    conn = setup(monkeypatch, rotate, [(expiry,), ('old pem', 'alice', None, 'registered date'), None, (1,)])
    monkeypatch.setattr(rotate, 'fingerprint_from_pem', lambda _: new_fp)
    with pytest.raises(HTTPException) as error:
        await rotate.rotate_key(rotation())
    assert error.value.status_code == status
    assert not any('DELETE FROM key_registry' in call.args[0] for call in conn.execute.call_args_list)


@pytest.mark.asyncio
async def test_revocation_removes_registration_and_outstanding_nonces(monkeypatch):
    expiry = datetime.now(timezone.utc) + timedelta(minutes=1)
    conn = setup(monkeypatch, revoke, [(expiry,), ('public key',), None, None])
    result = await revoke.revoke_key(revoke.RevokeRequest(fingerprint='old', nonce='nonce', signature='signature'))
    assert result == {'revoked': True}
    assert conn.execute.call_args_list[-1].args == ('DELETE FROM nonces WHERE fingerprint = %s', ('old',))


@pytest.mark.asyncio
@pytest.mark.parametrize('record', [None, (datetime.now(timezone.utc) - timedelta(minutes=1),)])
async def test_expired_or_missing_nonce_cannot_revoke(monkeypatch, record):
    conn = setup(monkeypatch, revoke, [record])
    with pytest.raises(HTTPException) as error:
        await revoke.revoke_key(revoke.RevokeRequest(fingerprint='old', nonce='nonce', signature='signature'))
    assert error.value.status_code == 400
    assert conn.execute.call_count == 1
