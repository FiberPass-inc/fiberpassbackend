# Fiber Channel Strategy And Live Test

FiberPass keeps customer funds in the vault ledger. Fiber channels are operator infrastructure for app/API and subscription payments.

## Read-Only Checks

- `GET /fiber/node/readiness`

The public readiness route returns only client-safe payment-execution state. It does not move funds.

## Operator Actions

These routes require `Authorization: Bearer <CRON_SECRET>`.

- `POST /fiber/channels/test-open`
- `POST /fiber/live-e2e`
- `GET /fiber/channels/strategy`
- `GET /fiber/node/status`

`/fiber/channels/test-open` opens a small test channel with the provided peer id, or the first external peer in `FIBER_TARGET_PEER_IDS`. It rejects the local node peer id.

`/fiber/live-e2e` sends a real Fiber payment request through the configured node. It requires a real invoice/payment request and only proves the Fiber node payment path; product pass debiting is still handled by the app charge API.

## Required Env

- `FIBER_RPC_URL`
- `FIBER_API_KEY` when the RPC gateway requires it
- `FIBER_PEER_ID` for the local node peer id reported by `node_info`
- `FIBER_TARGET_PEER_IDS` for comma-separated external peers that can receive channel opens
- `FIBER_TEST_CHANNEL_AMOUNT_CKB`, default `0.01`; use a larger amount such as `50` to `100` CKB for realistic test liquidity
- `CRON_SECRET` for operator write actions
