# Fiber Network Integration

FiberPass now uses only the RPC-backed `FiberProvider` in `src/services/fiberProvider.ts`.

## Required Runtime Configuration

- `FIBER_PROVIDER=rpc`
- `FIBER_RPC_URL` pointing at a Fiber node JSON-RPC endpoint
- `FIBER_PEER_ID` when opening a channel/session
- `FIBER_API_KEY` only if the RPC provider requires bearer auth

## Current Fiber Operations

- `createSession` calls `open_channel` with the configured peer id and requested funding amount.
- `authorizeCharge` calls `send_payment` and requires charge metadata containing a Fiber invoice as `fiberInvoice`.
- `topUpSession` calls `add_tlc` with the known network session id.
- `revokeSession` and `settleSession` call `shutdown_channel`.
- `getStatus` calls `channel` when a network session id exists, otherwise `node_info`.

## Spike Command

`tsx src/spikes/fiberNetworkRpcSpike.ts`

The spike checks configured RPC reachability. It does not create channels or move funds unless you invoke provider methods through the product API with real runtime configuration.
