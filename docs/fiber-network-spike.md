# Fiber Network Integration Spike

FiberPass now uses a typed `FiberProvider` boundary in `src/services/fiberProvider.ts`.

## Current Implementation

- `MockFiberProvider` is the default provider for local product/demo flows.
- `RpcFiberProvider` is an isolated JSON-RPC spike for a real Fiber node.
- `FIBER_PROVIDER=rpc` requires `FIBER_RPC_URL`.
- Opening a real channel currently requires `FIBER_PEER_ID` or request metadata with `fiberPeerId`.
- Real charges require a Fiber invoice/payment request in charge metadata as `fiberInvoice`.

## Why This Boundary Exists

FiberPass product logic needs stable operations: create session, charge, top up, revoke, settle, and status. Fiber Network primitives may expose those as channels, invoices, payment hashes, and settlement transactions. Keeping that under `FiberProvider` means the app and wallet UX can move while the real node integration is finalized.

## Spike Command

`tsx src/spikes/fiberNetworkRpcSpike.ts`

The command only checks RPC reachability/status. It intentionally does not open channels or move funds without explicit runtime configuration.

## Research Notes

The public Fiber Network implementation is hosted in the Nervos `fiber` repository and exposes node/RPC concepts such as invoices, send payment, opening channels, and shutting down channels. The RPC provider in this repo is a conservative adapter around those shapes, and should be updated against the exact node version used for testnet deployment.
