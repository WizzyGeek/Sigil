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
	docker compose run --build --rm registry python -m pytest
	docker compose run --build --rm broker go test ./...
	docker compose run --build --rm client npm run typecheck
	docker compose run --build --rm client npm test
