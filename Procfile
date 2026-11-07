client:   cd client && npm run dev
registry: cd registry && PYTHONPATH=src .venv/bin/uvicorn registry.main:app --reload --port 8000 --no-proxy-headers --timeout-keep-alive 30
broker:   cd broker && set -a && . ./.env && set +a && go run ./cmd/broker
