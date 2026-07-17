# FiberPass Backend

Node.js + TypeScript API for prepaid, revocable Fiber payment sessions.

FiberPass is licensed under the [Apache License 2.0](LICENSE). See
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a change and
[SECURITY.md](SECURITY.md) before reporting a vulnerability.

## System Design

See [docs/system-design.md](docs/system-design.md) for the full FiberPass architecture, user flow, developer flow, vault-to-Fiber liquidity design, and payment execution diagram.

See [docs/vault-recovery.md](docs/vault-recovery.md) for JoyID-bound vault ownership, owner-signed reclaim handoff, legacy synthetic-vault migration, and lifecycle transaction guarantees.

See [docs/funding-sources-and-guarantees.md](docs/funding-sources-and-guarantees.md) for connected-wallet and secured auto-pay modes, exact accounting invariants, proof freshness, source states, API fields, and conservative legacy migration.

See [docs/worker-reliability.md](docs/worker-reliability.md) for the required API/payment/reconciliation/webhook services, durable live events, heartbeats, locks, and delivery guarantees.

See [docs/webhook-security.md](docs/webhook-security.md) for webhook destination restrictions, encrypted secret storage, retry behavior, and the HMAC verification contract.

See [docs/production-operations.md](docs/production-operations.md) for migrations, release order, incidents, rollback, backup/restore, and key rotation.

Architecture decisions are indexed in [docs/adr/README.md](docs/adr/README.md).
The separation between Bitcoin/Lightning, CKB/Fiber, and stablecoin grant work
is documented in
[docs/grant-work-packages.md](docs/grant-work-packages.md).
The exact atomic-unit API contract and v1 migration behavior are documented in
[docs/api-money-contract-v2.md](docs/api-money-contract-v2.md).
Connector selection, capability discovery, and provider error isolation are
documented in [docs/payment-connectors.md](docs/payment-connectors.md).
Existing-wallet Lightning pairing, NIP-47 allowance rules, invoice validation,
and timeout reconciliation are documented in
[docs/nwc-lightning.md](docs/nwc-lightning.md).
Self-hosted BTCPay pairing, receive and Lightning payment recovery, interactive
Bitcoin PSBT signing, RBF, and Core deployment are documented in
[docs/bitcoin-btcpay-psbt.md](docs/bitcoin-btcpay-psbt.md).
Fresh-request schedules, calendar behavior, reusable resolver contracts,
occurrence idempotency, and paused/revoked reconciliation are documented in
[docs/scheduled-payments.md](docs/scheduled-payments.md).
Metered usage grants, immutable event receipts, safe batching, restart
reconciliation, and revocation behavior are documented in
[docs/metered-payments.md](docs/metered-payments.md).
Recipient identity, single-use destination claims, reusable destination rules,
and privacy deletion are documented in
[docs/recipient-identity-and-privacy.md](docs/recipient-identity-and-privacy.md).

## Stack

- Express API
- MongoDB + Mongoose
- JoyID challenge-response auth
- Server-Sent Events for live dashboard updates
- Exact atomic-unit string contracts with checked `bigint` arithmetic; numeric
  minor-unit fields remain only as the CKB/Fiber v1 compatibility projection
- Fiber Network JSON-RPC provider only
- Nostr Wallet Connect for externally owned Bitcoin Lightning wallets
- Self-hosted BTCPay Greenfield for scoped Bitcoin/Lightning operations
- Interactive Bitcoin PSBT construction with walletless Core validation and
  broadcast
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

## Current Fiber Provider

`FIBER_PROVIDER=rpc` is the only implemented provider today. Configure `FIBER_RPC_URL`, optional `FIBER_API_KEY`, `FIBER_PEER_ID` for the local node identity, and `FIBER_TARGET_PEER_IDS` for external channel peers. Configure `FIBERPASS_VAULT_CODE_HASH`, `FIBERPASS_VAULT_HASH_TYPE`, `FIBERPASS_VAULT_CELL_DEP_TX_HASH`, `FIBERPASS_VAULT_CELL_DEP_INDEX`, and `FIBERPASS_OPERATOR_LOCK_HASH` only for the unaudited CKB testnet contract draft. It derives owner-bound contract addresses; those addresses are not wallets issued by FiberPass. Keep `FIBERPASS_OPERATOR_PRIVATE_KEY` only in deployment secrets; it authorizes operator payout transactions and therefore creates a custody risk that must not be presented as user wallet authorization. `FIBERPASS_TREASURY_ADDRESS` is a temporary testnet fallback while the contract deployment is not configured.

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

Product endpoints are available at their current paths and under `/v1` aliases
for legacy clients. `/v2` aliases expose the additive exact-money contract; see
[docs/api-money-contract-v2.md](docs/api-money-contract-v2.md).

- `GET /health/live`
- `GET /health/ready`
- `GET /meta`
- `POST /auth/challenge`
- `POST /auth/verify`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /wallet/funding`
- `GET /wallet/funding-sources`
- `GET /wallet/vault-recovery`
- `GET /wallet/nwc-connections`
- `POST /wallet/nwc-connections`
- `POST /wallet/nwc-connections/:connectionId/balance/sync`
- `POST /wallet/nwc-connections/:connectionId/payments`
- `GET /wallet/nwc-connections/:connectionId/payments/:paymentHash`
- `DELETE /wallet/nwc-connections/:connectionId`
- `GET /wallet/btcpay-connections`
- `POST /wallet/btcpay-connections`
- `DELETE /wallet/btcpay-connections/:connectionId`
- `POST /wallet/btcpay-connections/:connectionId/invoices`
- `GET /wallet/btcpay-connections/:connectionId/invoices/:invoiceId`
- `POST /wallet/btcpay-connections/:connectionId/lightning-payments`
- `GET /wallet/btcpay-connections/:connectionId/lightning-payments/:paymentHash`
- `POST /wallet/bitcoin/psbts`
- `GET /wallet/bitcoin/psbts/:psbtId`
- `POST /wallet/bitcoin/psbts/:psbtId/submit`
- `POST /wallet/bitcoin/psbts/:psbtId/abandon`
- `POST /wallet/funding`
- `POST /wallet/funding/sync`
- `POST /wallet/funding/:fundingId/confirm`
- `GET /sessions/create-policy`
- `GET /payment-connectors`
- `GET /sessions`
- `POST /events/ticket`
- `GET /events?ticket=<short-lived-ticket>`
- `POST /sessions`
- `GET /recipient-claims/:token`
- `POST /recipient-claims/:token`
- `POST /recipient-claims/:token/destination-policy`
- `POST /sessions/:id/recipient-invites/resend`
- `POST /sessions/:id/recipient-claims/:claimId/revoke`
- `POST /sessions/:id/payment-destinations`
- `GET /sessions/:id/payment-schedules`
- `POST /sessions/:id/payment-schedules`
- `POST /payment-schedules/:id/control`
- `POST /payment-schedules/sync`
- `POST /sessions/:id/top-up`
- `POST /sessions/:id/toggle-pause`
- `POST /sessions/:id/revoke`
- `POST /sessions/:id/settle`
- `GET /privacy/export`
- `DELETE /privacy/contact-data`
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
- `GET /apps/:appId/metered-grants`
- `POST /apps/:appId/metered-grants`
- `POST /apps/:appId/metered-grants/:grantId/revoke`
- `POST /apps/:appId/usage-events`
- `GET /apps/:appId/usage-events`
- `GET /apps/:appId/metered-batches`
- `GET /apps/:appId/charges`
- `POST /apps/:appId/charges`

## Checks

```bash
npm run build
npm test
npm run test:bitcoin
npm run test:bitcoin-core-regtest
npm run test:schedules
npm run test:metered
```

The existing Mongoose duplicate-index warning is non-blocking test output; build and test exit codes must remain zero.
