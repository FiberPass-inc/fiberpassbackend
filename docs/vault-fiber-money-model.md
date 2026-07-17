# CKB Testnet Contract and Fiber Network Model

This document describes the current, unaudited CKB testnet contract draft. The
contract holds owner-bound cells and Fiber Network provides payment
infrastructure. It is not a wallet, does not issue an address controlled by a
FiberPass-generated seed, and must not be represented as production custody.
The backend ledger is an accounting view of observed and reserved testnet
funds, not proof that an external wallet still has liquid balance.

## Source of Funds

- Users load CKB into an owner-bound testnet contract address.
- The backend records the deposit against the connected JoyID CKB wallet.
- Creating a pass reserves that user's vault balance by moving it from available balance into the pass limit.
- Charges and scheduled payouts spend from the reserved pass balance.
- Closing, revoking, or settling a pass returns unused reserved balance to that user's available vault balance.

The dashboard must label this value as contract-locked CKB testnet funds and
show the source and observation time. It must not label the value as the user's
wallet balance, cumulative contract funds, or the operator node wallet balance.

## Fiber Network Role

Fiber nodes are infrastructure for payment execution and future channel/app payments. They are not individual user wallets.

- App/API charges execute through the Fiber payment adapter with a real payment request.
- Scheduled invoice payouts can use either a direct Fiber invoice/payment request or a normal recipient CKB address.
- A normal recipient CKB address uses the Fiber exit gateway path: vault reserve -> Fiber liquidity bridge -> Fiber payment to FiberPass exit invoice -> CKB settlement transaction to the recipient address.
- When Fiber channel liquidity is insufficient, FiberPass bridges the reserved user vault liquidity to the Fiber node funding lock, opens channel liquidity, and retries the Fiber payment when the channel is active.
- The Fiber node wallet may hold small operator buffer for channel fees/change. For CKB-address exits, the final settlement signer should be the Fiber node key or an explicitly configured exit settlement key. User balances remain tracked by vault accounting.

## Charge Invariants

Every charge attempt must be persisted with:

- session id and owner wallet id
- amount and currency
- idempotency key for app/API requests
- service reference when supplied by an app or invoice system
- reserve status: `reserved`, `debited`, or `released`
- execution layer: `fiber` or the existing serialized value `ckb-vault`
- proof type and proof id/transaction hash when successful
- failure code and message when blocked or failed

A successful charge increments pass spent balance exactly once. A failed charge does not spend reserved funds.
