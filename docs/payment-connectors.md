# Payment Connector Contract

Payment connectors isolate rail, network, destination, proof, and provider
behavior from session policy and ledger code. The registry selects one connector
by the exact tuple `(rail, network, assetId)`; it does not fall back by currency
or silently substitute a network.

## Lifecycle

For a new charge, the backend performs these steps in order:

1. Authorize the caller and validate the session policy.
2. Resolve the rail, network, asset id, and neutral destination.
3. Require a matching registered capability.
4. Ask that connector to validate and quote the intent.
5. Reserve the authorized amount only after the quote succeeds.
6. Execute with the same connector and persist its neutral proof.
7. Use connector lookup before retrying an uncertain result.

This order prevents unsupported rail/asset pairs, expired invoices, wrong
networks, unsigned invoices, and amount mismatches from creating reservations.

## Interface

Each connector declares capabilities and implements destination validation,
quote, execute, and lookup. Refund is optional and must be advertised. Inputs
use `PaymentIntent` and exact atomic strings; outputs use `PaymentQuote` and
`PaymentResult`. Provider-specific secrets and raw RPC responses are not part of
those contracts.

The current connectors advertise:

- `fiber` + configured CKB network + `ckb:ckb`, for signed Fiber invoices and
  explicitly configured endpoints;
- `ckb_onchain` + configured CKB network + `ckb:ckb`, for owner-bound testnet
  contract payouts to valid CKB addresses.

It contains Fiber invoice parsing, signature/expiry/network/amount checks, CKB
address and cell-minimum checks, node readiness access, payment execution, proof
normalization, and payment-hash lookup.

`NwcConnector` advertises `lightning` + `bitcoin:btc` for mainnet, testnet,
signet, and regtest. It validates amount-bearing BOLT11 invoices, executes only
wallet-advertised NIP-47 methods, verifies preimages, and performs
payment-hash lookup before any retry after an uncertain outcome. Its funding
mode is `connected_wallet`: the external wallet retains funds and enforcement.
See [nwc-lightning.md](nwc-lightning.md) for pairing, allowance, storage, and
disconnect guarantees.

## Capability Discovery

An authenticated wallet can call `GET /payment-connectors`,
`GET /v1/payment-connectors`, or `GET /v2/payment-connectors`. The response lists
connector id, rail, network, asset id, destination kinds, lookup support, and
refund support. It contains no credentials, node URL, liquidity, or raw provider
state.

## Public Errors

An unregistered tuple fails with `PAYMENT_CAPABILITY_UNSUPPORTED` before
reservation. Connector validation retains stable invoice and destination codes.
Unknown provider execution and lookup failures become
`PAYMENT_CONNECTOR_EXECUTION_FAILED` and `PAYMENT_CONNECTOR_LOOKUP_FAILED` with
canonical messages. Raw provider error text and RPC payloads remain internal.
