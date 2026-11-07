import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError
from registry.config import Settings
from registry import discovery_maintenance as maintenance


def pool(monkeypatch, rows, claimed=True):
    conn = AsyncMock()
    claim = AsyncMock(fetchone=AsyncMock(return_value=(True,) if claimed else None))
    sample = AsyncMock(fetchall=AsyncMock(return_value=rows))
    conn.execute.side_effect = [claim, sample, AsyncMock()] if claimed else [claim]
    cursor = AsyncMock()
    cursor_manager = AsyncMock()
    cursor_manager.__aenter__.return_value = cursor
    conn.cursor = lambda: cursor_manager
    manager = AsyncMock()
    manager.__aenter__.return_value = conn
    class Pool:
        def connection(self): return manager
    monkeypatch.setattr(maintenance,'get_pool',Pool)
    monkeypatch.setattr(maintenance.settings,'discovery_recheck_interval_seconds',21600)
    monkeypatch.setattr(maintenance.settings,'discovery_recheck_sample_size',20)
    return conn,cursor


@pytest.mark.asyncio
async def test_random_sample_refreshes_healthy_and_removes_failed_without_overwriting_newer_checks(monkeypatch):
    stamp=datetime.now(timezone.utc)
    rows=[('registry','https://one.example',stamp),('broker','wss://two.example/ws',stamp)]
    conn,cursor=pool(monkeypatch,rows)
    probe=AsyncMock(side_effect=[(True,''),(False,'unreachable')]);monkeypatch.setattr(maintenance,'probe_endpoint',probe)
    assert await maintenance.sweep_once()
    sql,args=conn.execute.call_args_list[1].args
    assert 'ORDER BY RANDOM()' in sql and args==(20,)
    refresh,remove=cursor.executemany.call_args_list
    assert 'SET verified_at = NOW()' in refresh.args[0]
    assert 'verified_at = %s' in refresh.args[0]
    assert refresh.args[1]==[rows[0]]
    assert remove.args[0].startswith('DELETE') and 'verified_at = %s' in remove.args[0]
    assert remove.args[1]==[rows[1]]
    assert conn.execute.call_args_list[-1].args[1][0] is True
    assert 'lease_token = %s' in conn.execute.call_args_list[-1].args[0]


@pytest.mark.asyncio
async def test_due_claim_prevents_duplicate_worker_sweeps(monkeypatch):
    conn,cursor=pool(monkeypatch,[],claimed=False)
    probe=AsyncMock();monkeypatch.setattr(maintenance,'probe_endpoint',probe)
    assert not await maintenance.sweep_once()
    claim=conn.execute.call_args.args[0]
    assert 'next_run_at <= NOW()' in claim and 'lease_until <= NOW()' in claim
    assert conn.execute.call_count==1
    probe.assert_not_called();cursor.executemany.assert_not_called()


@pytest.mark.asyncio
async def test_probe_errors_leave_rows_and_schedule_a_retry(monkeypatch):
    row=('broker','wss://one.example/ws',datetime.now(timezone.utc))
    conn,cursor=pool(monkeypatch,[row])
    monkeypatch.setattr(maintenance,'probe_endpoint',AsyncMock(side_effect=RuntimeError('unexpected probe error')))
    with pytest.raises(RuntimeError): await maintenance.sweep_once()
    cursor.executemany.assert_not_called()
    assert conn.execute.call_args_list[-1].args[1][0] is False
    assert "INTERVAL '60 seconds'" in conn.execute.call_args_list[-1].args[0]


@pytest.mark.asyncio
async def test_shutdown_cancellation_releases_lease_without_deleting_rows(monkeypatch):
    conn,cursor=pool(monkeypatch,[('broker','wss://one.example/ws',datetime.now(timezone.utc))])
    started=asyncio.Event()
    async def stalled(*args): started.set(); await asyncio.Event().wait()
    monkeypatch.setattr(maintenance,'probe_endpoint',stalled)
    task=asyncio.create_task(maintenance.sweep_once());await started.wait();task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    cursor.executemany.assert_not_called()
    assert conn.execute.call_args_list[-1].args[1][0] is False


@pytest.mark.asyncio
async def test_large_samples_use_bounded_batches(monkeypatch):
    rows=[('broker',f'wss://{i}.example/ws',datetime.now(timezone.utc)) for i in range(21)]
    _,cursor=pool(monkeypatch,rows)
    monkeypatch.setattr(maintenance.settings,'discovery_recheck_sample_size',25)
    active=peak=0
    async def probe(*args):
        nonlocal active,peak
        active+=1;peak=max(peak,active)
        await asyncio.sleep(0)
        active-=1
        return True,''
    monkeypatch.setattr(maintenance,'probe_endpoint',probe)
    await maintenance.sweep_once()
    assert peak==8
    assert [len(call.args[1]) for call in cursor.executemany.call_args_list]==[8,8,5]


@pytest.mark.asyncio
async def test_background_loop_recovers_after_errors(monkeypatch,caplog):
    sweep=AsyncMock(side_effect=[RuntimeError('temporary db error'),False])
    sleeps=0
    async def sleep(_seconds):
        nonlocal sleeps
        sleeps+=1
        if sleeps==2: raise asyncio.CancelledError()
    monkeypatch.setattr(maintenance,'sweep_once',sweep);monkeypatch.setattr(maintenance.asyncio,'sleep',sleep)
    with pytest.raises(asyncio.CancelledError): await maintenance.run_discovery_maintenance()
    assert sweep.await_count==2
    assert 'will retry' in caplog.text


@pytest.mark.asyncio
async def test_disabled_background_checks_do_no_database_work(monkeypatch):
    monkeypatch.setattr(maintenance.settings,'discovery_recheck_interval_seconds',0)
    get_pool=Mock(side_effect=AssertionError('should not access database'))
    monkeypatch.setattr(maintenance,'get_pool',get_pool)
    assert not await maintenance.sweep_once()
    get_pool.assert_not_called()


def test_maintenance_settings_are_bounded():
    with pytest.raises(ValidationError): Settings(discovery_recheck_sample_size=0)
    with pytest.raises(ValidationError): Settings(discovery_recheck_interval_seconds=-1)


@pytest.mark.asyncio
async def test_cleanup_failure_does_not_swallow_shutdown_cancellation(monkeypatch):
    conn,_=pool(monkeypatch,[('broker','wss://one.example/ws',datetime.now(timezone.utc))])
    original=list(conn.execute.side_effect)
    conn.execute.side_effect=original[:2]+[RuntimeError('database unavailable during release')]
    started=asyncio.Event()
    async def stalled(*args): started.set(); await asyncio.Event().wait()
    monkeypatch.setattr(maintenance,'probe_endpoint',stalled)
    task=asyncio.create_task(maintenance.sweep_once());await started.wait();task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
