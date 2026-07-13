# Local Fiber Node Testing

This is the local loop for testing real Fiber RPC reachability from FiberPass.

The current production invoice payout flow still uses the CKB vault path. These steps are for the Fiber channel/app-payment path: node status, channel open, invoice send, top up, and channel close.

## 1. Prepare Fiber node env

```bash
cd fiberpassbackend
cp infra/fiber-node/.env.example infra/fiber-node/.env
```

For local testing keep:

```bash
FIBER_RPC_LOCAL_PORT=8227
FIBER_P2P_PORT=8228
CKB_TESTNET_RPC_URL=https://testnet.ckb.dev/
```

Set a real node password:

```bash
FIBER_SECRET_KEY_PASSWORD=replace-with-a-long-node-password
```

## 2. Create the node CKB key

The Fiber node needs a CKB testnet key file for channel operations.

```bash
mkdir -p infra/fiber-node/data/ckb
nano infra/fiber-node/data/ckb/key
chmod 600 infra/fiber-node/data/ckb/key
```

Fund that key from the Pudge faucet before opening channels.

## 3. Start only the local Fiber node

```bash
npm run fiber:node:up:local
```

This renders `infra/fiber-node/data/config.yml` and starts the `fiber-node` container.

Local RPC is bound to host loopback only:

```txt
http://127.0.0.1:8227
```

## 4. Check node status

```bash
npm run fiber:node:status
```

Or through the backend:

```bash
curl http://localhost:4000/fiber/node/status
```

Expected shape:

```json
{
  "configured": true,
  "reachable": true,
  "provider": "rpc",
  "network": "testnet"
}
```

## 5. Backend env for local Fiber tests

In `fiberpassbackend/.env`:

```bash
FIBER_PROVIDER=rpc
FIBER_NETWORK=testnet
FIBER_RPC_URL=http://127.0.0.1:8227
FIBER_API_KEY=
FIBER_PEER_ID=<peer id to open channel against>
```

Restart the backend after changes.

## 6. Logs and shutdown

```bash
npm run fiber:node:logs
npm run fiber:node:down
```
