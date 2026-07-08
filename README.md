# FiberPass Backend

Node.js + TypeScript API for prepaid, revocable Fiber payment sessions.

## Stack

- Express API
- MongoDB + Mongoose
- JoyID EVM challenge-response auth
- Server-Sent Events for live dashboard updates
- Integer minor-unit accounting for money values
- Pluggable Fiber provider: mock locally, JSON-RPC spike for real Fiber nodes
- Rate limiting, audit logs, request IDs, and production env validation

## Run Locally

```bash
cp .env.example .env
docker compose up -d mongo
npm install
npm run dev
```

API runs on `http://localhost:4000` by default.

Product mode is the default: authenticated JoyID wallets start with no seeded sessions. Set `DEMO_MODE=true` to mount `/demo/*` endpoints and seeded demo data. `DEMO_MODE=true` is rejected in production.

## Fiber Provider

`FIBER_PROVIDER=mock` is the local default and keeps all network effects behind `MockFiberProvider`.

`FIBER_PROVIDER=rpc` enables the JSON-RPC spike provider and requires `FIBER_RPC_URL`. Real channel opening also needs `FIBER_PEER_ID`, and real app charges need a Fiber invoice/payment request in charge metadata as `fiberInvoice`.

See `docs/fiber-network-spike.md` for integration notes.

## Core Endpoints

All product endpoints are available at their current paths and under `/v1` aliases.

- `GET /health`
- `GET /meta`
- `POST /auth/challenge`
- `POST /auth/verify`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /sessions/create-policy`
- `GET /sessions`
- `GET /events`
- `POST /sessions`
- `POST /sessions/:id/top-up`
- `POST /sessions/:id/toggle-pause`
- `POST /sessions/:id/revoke`
- `POST /sessions/:id/settle`
- `GET /apps`
- `POST /apps`
- `POST /apps/:appId/api-keys`
- `POST /apps/:appId/api-keys/:keyId/revoke`
- `GET /apps/:appId/charges`
- `POST /apps/:appId/charges`

Demo endpoints are mounted only when `DEMO_MODE=true`.

## Checks

```bash
npm run build
npm test
```
