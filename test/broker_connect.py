"""
Broker WebSocket smoke test.

Usage:
    .venv/bin/python broker_connect.py [ws://localhost:8080/ws]

What it does:
    1. Opens a WebSocket connection to the broker
    2. Sends a subscribe command for the 'general' channel
    3. Listens for 10 seconds and prints any messages received
    4. Reports success / failure
"""

import asyncio
import json
import sys

import websockets


BROKER_URL = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8080/ws"


async def run() -> None:
    print(f"Connecting to {BROKER_URL} ...")
    try:
        async with websockets.connect(BROKER_URL, open_timeout=5) as ws:
            print("✓ Connected")

            subscribe = {"type": "subscribe", "channels": ["general"]}
            await ws.send(json.dumps(subscribe))
            print(f"→ Sent: {json.dumps(subscribe)}")

            print("Listening for 10 s (Ctrl-C to stop early) ...\n")
            deadline = asyncio.get_event_loop().time() + 10
            while True:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    break
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    print(f"← Received: {raw}")
                except asyncio.TimeoutError:
                    break

            print("\n✓ Done — broker connection OK")

    except OSError as exc:
        print(f"✗ Connection failed: {exc}")
        sys.exit(1)
    except websockets.exceptions.WebSocketException as exc:
        print(f"✗ WebSocket error: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run())
