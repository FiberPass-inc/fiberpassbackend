# Self-Hosted BTCPay And Interactive Bitcoin PSBTs

FiberPass supports two self-hosted Bitcoin paths without issuing a wallet or
holding a wallet seed:

- a scoped BTCPay Greenfield connection for Bitcoin/Lightning receive invoices
  and Lightning payments; and
- a wallet-signed PSBT flow for interactive on-chain Bitcoin payments.

Both use the chain-neutral `bitcoin:btc` asset contract. Its atomic unit is one
millisatoshi on every rail. Lightning amounts may use any whole millisatoshi.
On-chain amounts and fees must be divisible by 1,000 and are converted to whole
satoshis only at the Bitcoin connector boundary.

## Custody Boundary

FiberPass never creates a seed, derives a user address, or signs a Bitcoin
input. The user supplies an existing receive or change address and signs every
PSBT in an external wallet. The production Bitcoin Core endpoint should be a
walletless node, preferably started with `disablewallet=1`; the application RPC
client exposes only chain inspection, PSBT finalization, mempool validation,
broadcast, and transaction lookup methods.

BTCPay's store Lightning API can execute payments from the store's configured
Lightning node. A paired key is therefore an execution credential, not merely
an identifier. Create a separate key for each FiberPass scope and protect the
server-side encryption key as production secret material.

## BTCPay Pairing

An authenticated owner pairs a connection with
`POST /wallet/btcpay-connections`. A connection belongs to exactly one
`wallet`, owned `pass`, or active owned `app`. Pairing verifies the current key
against BTCPay and requires exactly these store-scoped permissions:

```text
btcpay.store.cancreateinvoice:<storeId>
btcpay.store.canviewinvoices:<storeId>
btcpay.store.canuselightningnode:<storeId>
```

An unscoped key, a server-wide key, or a key containing additional permissions
is rejected. The credential is encrypted with AES-256-GCM under
`BTCPAY_SECRET_ENCRYPTION_KEY`. Responses expose only non-secret connection
metadata and a short SHA-256 fingerprint. The API key, raw provider errors, and
authorization header are never returned or written to audit metadata.

`DELETE /wallet/btcpay-connections/:connectionId` first asks BTCPay to revoke
the current key and then destroys the local ciphertext and server/store
coordinates even if the remote request fails. The response reports
`remoteRevoked`; when it is false, the operator must confirm revocation in
BTCPay.

Production BTCPay origins must be public HTTPS on port 443. The client resolves
all addresses, rejects private/link-local destinations, and pins a vetted
address for the request. `BTCPAY_ALLOW_INSECURE_LOCAL=true` is limited to a
localhost development or regtest fixture and is rejected in production.

## Receive Invoices

`POST /wallet/btcpay-connections/:connectionId/invoices` creates either a
`lightning` or `bitcoin_onchain` invoice. It requires an idempotency key and an
exact positive amount. The backend validates the returned store, currency,
amount, payment method, network, and BOLT11 or BIP21 destination before
returning the request.

FiberPass stores the invoice identity, amount, status, expiry, and a hash of the
payment request. It does not store the raw BOLT11 invoice or BIP21 request.

Invoice creation reserves a local FiberPass invoice ID before calling BTCPay
and sends that ID as BTCPay `metadata.orderId`. If the process or connection
fails after BTCPay creates the invoice, replay searches Greenfield by that
order ID and attaches the original invoice. It never blindly sends a second
create request. Multiple remote invoices for one order ID fail closed for
operator investigation.

## Lightning Payments

`POST /wallet/btcpay-connections/:connectionId/lightning-payments` accepts an
amount-bearing BOLT11 invoice, a whole-satoshi maximum fee expressed in
millisatoshis, and an idempotency key. Before execution FiberPass verifies the
invoice network, exact amount, signature, payment hash, and expiry.

BTCPay results are accepted only when:

- the returned payment hash matches the invoice;
- the returned preimage hashes to that payment hash;
- the fee does not exceed the reviewed maximum; and
- the provider total equals the invoice amount plus its fee.

The preimage and raw invoice are discarded. Persistence contains only their
hashes and normalized proof metadata. A timeout is `uncertain`, not failed.
Every replay or status request performs payment-hash lookup before another
execution, so a lost response cannot become a duplicate payment.

## Interactive PSBT Flow

`POST /wallet/bitcoin/psbts` accepts a reviewed recipient or BIP21 destination,
amount, explicit funding outpoints, user-controlled change address, fee rate,
maximum fee, and confirmation policies. FiberPass asks the configured Core node
for each UTXO and supports native P2WPKH and Taproot inputs. Coinbase maturity,
input confirmations, address network, BIP21 amount, conservative dust, fee cap,
and exact input/output balance are checked before a PSBT is returned.

The returned PSBT uses transaction version 2 and replace-by-fee sequences. The
user inspects and signs it in an existing wallet, then submits it to
`POST /wallet/bitcoin/psbts/:psbtId/submit`.

Before broadcast FiberPass revalidates all of the following against the stored
reviewed plan:

- transaction version, input order, outpoints, sequences, values, and scripts;
- recipient script and exact satoshi amount;
- change script and exact satoshi amount;
- total fee and maximum fee policy; and
- the complete unsigned-transaction fingerprint.

Bitcoin Core must finalize the PSBT and `testmempoolaccept` must accept the
exact raw transaction. FiberPass persists its raw transaction and txid before
calling `sendrawtransaction`, allowing a restart or lost broadcast response to
reconcile without asking the wallet to sign or pay again. Raw transactions and
unsigned PSBTs are excluded from ordinary database queries and API responses
after submission.

`GET /wallet/bitcoin/psbts/:psbtId` reconciles mempool and indexed-chain state.
An unbroadcast request can be abandoned with
`POST /wallet/bitcoin/psbts/:psbtId/abandon`. An RBF replacement passes
`replacesPsbtId`, preserves the network, recipient, amount, inputs, and change,
and must increase both the fee rate and absolute fee.

## API

All routes require wallet bearer authentication and are mounted at their root,
`/v1`, and `/v2` paths.

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

## Deployment

Configure:

```dotenv
BTCPAY_SECRET_ENCRYPTION_KEY=<32 random bytes as hex or base64>
BTCPAY_REQUEST_TIMEOUT_MS=15000
BTCPAY_ALLOW_INSECURE_LOCAL=false
BITCOIN_NETWORK=mainnet
BITCOIN_CORE_RPC_URL=http://bitcoin-core.internal:8332
BITCOIN_CORE_RPC_USER=<dedicated rpc user>
BITCOIN_CORE_RPC_PASSWORD=<dedicated rpc password>
BITCOIN_CORE_RPC_TIMEOUT_MS=15000
```

Keep Core RPC on a private authenticated network and do not reuse its
credentials for an operator wallet. Mainnet activation requires an independent
security review, tested backup/restore, fee policy, monitoring, and incident
runbook.

## Verification

Run protocol and deterministic provider failure coverage with:

```bash
npm test
BITCOIN_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm run test:bitcoin
```

CI also runs `npm run test:bitcoin-core-regtest` against a digest-pinned Bitcoin
Core 29.1 container. That test creates a separate external regtest wallet,
mines a mature UTXO, asks FiberPass for a PSBT, signs only in the external test
wallet, broadcasts through FiberPass's walletless RPC client, mines a block,
and verifies confirmation. The deterministic BTCPay fixture separately covers
least-privilege pairing, encrypted storage, receive and Lightning payment
flows, socket-loss recovery, duplicate prevention, PSBT mutation rejection,
RBF, and credential destruction.
