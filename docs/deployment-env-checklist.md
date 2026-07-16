# FiberPass Deployment Env Checklist

Use this checklist before each production-like deploy.

## Frontend

- `VITE_API_BASE_URL`: deployed backend URL.
- `PUBLIC_APP_URL` equivalent in backend must point to the deployed frontend, not localhost.

## Backend

Required:

- `NODE_ENV=production`
- `MONGODB_URI`: replica set or sharded cluster; standalone MongoDB cannot provide charge reservation transactions.
- `FRONTEND_ORIGIN`: deployed frontend origin.
- `PUBLIC_APP_URL`: deployed frontend URL for magic links and emails.
- `CRON_SECRET`: strong random value for worker/operator routes.
- `CKB_TESTNET_RPC_URL` and `CKB_TESTNET_INDEXER_URL`

Vault funds and signing:

- `FIBERPASS_VAULT_CODE_HASH`
- `FIBERPASS_VAULT_HASH_TYPE`
- `FIBERPASS_VAULT_CELL_DEP_TX_HASH`
- `FIBERPASS_VAULT_CELL_DEP_INDEX`
- `FIBERPASS_VAULT_CELL_DEP_TYPE`
- `FIBERPASS_OPERATOR_LOCK_HASH`
- `FIBERPASS_OPERATOR_PRIVATE_KEY`
- `WEBHOOK_SECRET_ENCRYPTION_KEY`: stable 32-byte hex/base64 key; required before webhook configuration or migration.

Fiber node infrastructure:

- `FIBER_PROVIDER=rpc`
- `FIBER_NETWORK=testnet`
- `FIBER_RPC_URL`: reachable HTTPS Fiber RPC gateway, not `127.0.0.1` or `localhost`.
- `FIBER_RPC_TIMEOUT_MS`: maximum time for invoice parsing and payment RPC requests.
- `FIBER_API_KEY`: gateway token if the node is protected.
- `FIBER_PEER_ID`: local node peer id reported by `node_info`.
- `FIBER_TARGET_PEER_IDS`: comma-separated external peer ids used for channel opening and strategy.
- `FIBER_NODE_CKB_PRIVATE_KEY`: Fiber node funding signer.
- `FIBER_EXIT_KEYSEND_TARGET_PUBKEY`: destination used for Fiber exit keysend.
- `FIBER_EXIT_SETTLEMENT_PRIVATE_KEY`: CKB settlement signer for Fiber exits.
- `FIBER_EXIT_SETTLEMENT_LOCK_HASH`: expected settlement signer lock hash.
- `FIBER_EXIT_INVOICE_EXPIRY_SECONDS`: bounded exit invoice lifetime.

Email notifications:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_FROM_ADDRESS`
- `EMAIL_FROM_NAME`

## Startup Protection

In `NODE_ENV=production`, backend config rejects:

- wildcard frontend origin
- localhost Fiber RPC URL
- localhost public app URL
- missing `CRON_SECRET`

Run `npm run start:migrate` as a one-off release step before starting API or workers. See [production-operations.md](production-operations.md) for backup, rollback, incident, restore, and key-rotation procedures.
