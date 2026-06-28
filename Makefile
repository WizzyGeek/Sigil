.PHONY: up down build logs ps test

up:
	docker compose up

build:
	docker compose build

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

test:
	docker compose run --rm registry python -m pytest
	docker compose run --rm broker go test ./...
	docker compose run --rm client npm run typecheck
