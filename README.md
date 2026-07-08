# FiberPass Backend

Node.js + TypeScript API for prepaid, revocable Fiber payment sessions.

## Stack

- Express API
- MongoDB + Mongoose
- JoyID EVM challenge-response auth
- Server-Sent Events for live dashboard updates
- Fiber adapter placeholder for real Fiber SDK/RPC integration

## Run locally

```bash
cp .env.example .env
docker compose up -d mongo
npm install
npm run dev
```

API runs on `http://localhost:4000` by default. Product mode is the default: authenticated JoyID wallets start with no seeded sessions. Set `DEMO_MODE=true` to enable seeded demo data and `/demo/*` endpoints, and set `DEMO_AUTO_CHARGE=true` only when you want automated demo charges.

## Core endpoints

- `GET /health`
- `POST /auth/challenge`
- `POST /auth/verify`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /sessions`
- `GET /events`
- `POST /sessions`
- `POST /sessions/:id/top-up`
- `POST /sessions/:id/toggle-pause`
- `POST /sessions/:id/revoke`
- `POST /sessions/:id/settle`
- `POST /demo/charge`
- `POST /demo/charge/random`
- `POST /demo/reset`
