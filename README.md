# FiberPass Backend

Node.js + TypeScript API for prepaid, revocable Fiber payment sessions.

## System Design

See [docs/system-design.md](docs/system-design.md) for the full FiberPass architecture, user flow, developer flow, vault-to-Fiber liquidity design, and payment execution diagram.

See [docs/vault-recovery.md](docs/vault-recovery.md) for JoyID-bound vault ownership, owner-signed reclaim handoff, legacy synthetic-vault migration, and lifecycle transaction guarantees.

See [docs/worker-reliability.md](docs/worker-reliability.md) for the required API/payment/reconciliation/webhook services, durable live events, heartbeats, locks, and delivery guarantees.

## Stack

- Express API
- MongoDB + Mongoose
- JoyID challenge-response auth
- Server-Sent Events for live dashboard updates
- Integer minor-unit accounting for money values
- Fiber Network JSON-RPC provider only
- Rate limiting, audit logs, request IDs, and production env validation

## Run Locally

```bash
cp .env.example .env
docker compose up -d mongo
npm install
npm run dev
```

API runs on `http://localhost:4000` by default. A real Fiber RPC URL is required through `FIBER_RPC_URL`; the backend exposes only product endpoints backed by the configured Fiber RPC provider.

Automation requires the API plus payment and webhook workers when queued invoices or callbacks are enabled:

```bash
npm run worker:payments
npm run worker:webhooks
```

## Fiber Provider

`FIBER_PROVIDER=rpc` is the only supported provider. Configure `FIBER_RPC_URL`, optional `FIBER_API_KEY`, `FIBER_PEER_ID` for the local node identity, and `FIBER_TARGET_PEER_IDS` for external channel peers. Configure `FIBERPASS_VAULT_CODE_HASH`, `FIBERPASS_VAULT_HASH_TYPE`, `FIBERPASS_VAULT_CELL_DEP_TX_HASH`, `FIBERPASS_VAULT_CELL_DEP_INDEX`, and `FIBERPASS_OPERATOR_LOCK_HASH` after deploying the vault lock script so funding requests derive per-user vault addresses and direct vault payouts can spend those cells. Keep `FIBERPASS_OPERATOR_PRIVATE_KEY` only in local/prod secrets; it authorizes vault payout transactions. `FIBERPASS_TREASURY_ADDRESS` remains a temporary fallback while vault deployment is not configured.

See `docs/fiber-network-spike.md` for integration notes. For a production-capable Docker node and authenticated RPC gateway, see `docs/fiber-node-deployment.md`.

## Automation

Automation docs live in:

- `docs/automation-api.md`
- `docs/automation-e2e-demo.md`
- `docs/automation-deployment.md`

Run the real API-driven demo flow with `npm run demo:automation` after exporting the required wallet auth token, app id, session id, recipients, and Fiber invoice/payment requests.

## Lock Scripts

Vault lock-script drafts live in `lockscripts/`. The current `fiberpass-vault-lock` draft models testnet user vault cells with per-user lock args so funding records stay distinct across users. Use `npm run vault:build` and `npm run vault:deploy:testnet` after funding the local deployer wallet. Testnet deployment details are recorded in `docs/vault-testnet-deployment.md`.

## Core Endpoints

All product endpoints are available at their current paths and under `/v1` aliases.

- `GET /health`
- `GET /meta`
- `POST /auth/challenge`
- `POST /auth/verify`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /wallet/funding`
- `GET /wallet/vault-recovery`
- `POST /wallet/funding`
- `POST /wallet/funding/sync`
- `POST /wallet/funding/:fundingId/confirm`
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
- `POST /apps/:appId/webhook`
- `GET /apps/:appId/webhook-deliveries`
- `GET /apps/:appId/recipients`
- `POST /apps/:appId/recipients`
- `GET /apps/:appId/invoices`
- `POST /apps/:appId/invoices`
- `POST /apps/:appId/invoices/:invoiceId/queue`
- `GET /apps/:appId/invoice-batches`
- `POST /apps/:appId/invoice-batches`
- `POST /apps/:appId/invoice-batches/:batchId/queue`
- `GET /apps/:appId/payment-jobs`
- `GET /apps/:appId/charges`
- `POST /apps/:appId/charges`

## Checks

```bash
npm run build
npm test
```

The existing Mongoose duplicate-index warning is non-blocking test output; build and test exit codes must remain zero.
