# ── dev ───────────────────────────────────────────────────────────────────────
FROM golang:1.21-alpine AS dev
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
# source mounted as volume by compose
CMD ["go", "run", "./cmd/broker"]

# ── build ─────────────────────────────────────────────────────────────────────
FROM golang:1.21-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /broker ./cmd/broker

# ── prod ──────────────────────────────────────────────────────────────────────
FROM scratch AS prod
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /broker /broker
ENTRYPOINT ["/broker"]
