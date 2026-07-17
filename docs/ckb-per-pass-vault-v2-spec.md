# CKB Per-Pass Vault V2 Specification

Status: draft for CKB/Fiber maintainer review. Not implemented, audited, or
approved for mainnet.

This specification replaces the current testnet v1 operator-vault design. V1
isolates backend user records but lets the operator authorize an otherwise
unrestricted payout. V2 makes one pass the on-chain authority boundary and
commits every operator-controlled payout dimension before funds enter it.

The companion executable reference model is src/domain/vaultV2.ts. Valid and
invalid vectors are in src/tests/vaultV2Model.test.ts. They describe intended
consensus behavior; they are not a deployed lock script.

## Normative Terms And Sources

MUST, MUST NOT, SHOULD, and MAY are normative.

The implementation must use canonical Molecule encoding as defined by CKB RFC
0008:

https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0008-serialization/0008-serialization.md

Transaction since is a lower-bound validity rule under CKB RFC 0017:

https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0017-tx-valid-since/0017-tx-valid-since.md

UDT support must be limited to reviewed sUDT/xUDT-compatible type scripts. xUDT
keeps the uint128 amount at the start of cell data, so V2 does not overwrite
asset-cell data with vault state:

https://github.com/nervosnetwork/ckb-miscellaneous-scripts

The implementation must pin ckb-std, system-script, Molecule compiler,
ckb-debugger, Rust toolchain, and deployment code hashes before audit.

## Security Goals

1. A compromised operator cannot redirect a payment.
2. A compromised operator cannot exceed total, per-payment, occurrence,
   cadence, expiry, or fee policy.
3. One pass cannot consume, credit, or validate another pass's cells.
4. The owner can revoke and reclaim with the existing JoyID/CKB wallet without
   an operator signature.
5. UDT identity is the full type script hash, never symbol, decimal count, or
   display name.
6. A successful transition conserves the exact native capacity or UDT amount.
7. A stale state, replayed request, duplicated occurrence, or concurrent spend
   cannot produce two accepted successors.
8. No backend database state can weaken the on-chain rules.

Availability, recipient cooperation, channel liquidity, and operator liveness
are not guaranteed by the lock.

## Cell Layout

Every pass has one V2 lock script and one unique state type script. The lock
args make each pass a separate CKB script group. The state type script gives
the state cell a Type ID-style unique identity and validates initial creation.

### Lock Args

Fixed-width bytes:

    byte 0       lock version: 0x02
    bytes 1-32   pass_id_hash
    bytes 33-64  owner_lock_hash
    bytes 65-96  operator_lock_hash
    bytes 97-128 policy_hash

All hashes are 32-byte CKB script or CKB-default hashes. pass_id_hash is derived
from a random public pass id and network domain separator. It MUST NOT contain
an email address, wallet address, database id, or other personal data.

owner_lock_hash is the full lock script hash of the existing JoyID/CKB owner.
operator_lock_hash is the full hash of a reviewed threshold multisig lock. A
single service key is forbidden in production.

policy_hash is CKB-default-hash over the exact canonical Molecule bytes supplied
in the first group witness. The lock MUST reject non-canonical or mismatched
policy bytes.

### Policy Molecule Schema

Integer arrays are unsigned little-endian. Byte32 is a 32-byte array.

    array Uint32  [byte; 4];
    array Uint64  [byte; 8];
    array Uint128 [byte; 16];
    array Byte32  [byte; 32];

    table VaultV2Policy {
      version:                 Uint32,
      network_genesis_hash:    Byte32,
      pass_id_hash:            Byte32,
      owner_lock_hash:          Byte32,
      operator_lock_hash:       Byte32,
      recipient_lock_hash:      Byte32,
      state_type_hash:          Byte32,
      asset_kind:              byte,
      asset_type_hash:          Byte32,
      total_cap_atomic:         Uint128,
      per_payment_cap_atomic:   Uint128,
      cadence_seconds:          Uint64,
      occurrence_limit:         Uint32,
      expiry_seconds:           Uint64,
      fee_ceiling_shannons:     Uint64
    }

asset_kind 0 means native CKB and requires an all-zero asset_type_hash.
asset_kind 1 means reviewed UDT and requires the exact non-zero type script
hash. Unknown values MUST fail.

expiry_seconds 0 means no time expiry. Any non-zero expiry remains disabled for
production until the time-evidence blocker below is resolved.

The policy is immutable. Owner migration consumes the V2 state; it does not
mutate policy_hash in place.

### State Cell

Exactly one group input and, except for full reclaim/migration, one group output
MUST have type hash policy.state_type_hash. No other group cell may carry that
type.

State cell data is canonical Molecule:

    table VaultV2State {
      version:                  Uint32,
      policy_hash:              Byte32,
      remaining_atomic:         Uint128,
      occurrence_count:         Uint32,
      next_valid_after_seconds: Uint64,
      nonce:                    Uint64,
      status:                   byte
    }

status 0 is active and 1 is revoked. Unknown status fails.

The state type script MUST validate initial creation:

- its Type ID identity is unique;
- lock args and policy hashes match;
- nonce and occurrence count are zero;
- status is active;
- remaining equals the exact V2 group asset amount;
- remaining is positive and no greater than total cap; and
- the state cell and asset cells use the expected V2 lock.

Creation is not considered funded until confirmed and indexed. Sending assets
to a malformed or state-less V2 address can make them unspendable and MUST NOT
be credited.

### Asset Cells

Native CKB:

- every V2 group cell MUST have no asset type script except the state type on
  the state cell;
- remaining_atomic equals the sum of V2 group cell capacities;
- output remaining equals input capacity minus recipient capacity and any fee
  charged to the group; and
- all cells must still satisfy occupied-capacity rules.

UDT:

- the state cell carries only state and preserves its CKB capacity;
- each asset cell MUST use exactly policy.asset_type_hash;
- the first 16 asset-data bytes are the canonical little-endian uint128 amount
  required by sUDT/xUDT;
- remaining_atomic equals the exact sum of V2 UDT input amounts;
- output remaining equals input UDT minus recipient UDT; and
- transaction CKB fees MUST be funded outside the V2 group. State-cell
  capacity cannot be drained during a UDT payout.

Unknown type scripts, mixed UDT hashes, overflow, malformed data, duplicate
state cells, or amount mismatch fail.

## Witness

The first group input WitnessArgs lock field starts with:

    byte 0       action
    bytes 1..    canonical VaultV2Witness Molecule table

    table VaultV2Witness {
      policy:                Bytes,
      verified_time:         Bytes,
      migration_target_lock: Bytes
    }

Actions:

    0x00 operator payout
    0x01 owner top-up
    0x02 owner revoke
    0x03 owner full reclaim
    0x04 owner migration

Unknown action or unexpected witness fields fail. The lock must scan all inputs
for the required auth lock hash. The auth input is validated by its own JoyID,
CKB multisig, or approved lock script.

## Global Isolation Rules

Every action MUST:

- consume exactly one V2 pass script group;
- reject any transaction input using the V2 code hash with different args;
- consume exactly one state input;
- reject type or amount arithmetic overflow;
- verify input asset sum equals state.remaining_atomic;
- enforce total transaction fee at or below fee_ceiling_shannons; and
- reject recipient inputs during operator payout so an existing recipient cell
  cannot be recycled to satisfy the output check.

The one-pass-per-transaction rule is mandatory. Without it, two V2 groups could
both count one shared recipient output and incorrectly validate cell mixing.

## State Transitions

### Operator Payout

Requires an input whose lock hash equals operator_lock_hash. It MUST:

- start active;
- prove approved non-replayable time evidence;
- be at or after next_valid_after_seconds and before expiry_seconds;
- have occurrence_count below occurrence_limit;
- pay a positive amount no greater than per_payment_cap_atomic and remaining;
- create recipient asset output only at recipient_lock_hash;
- preserve asset identity;
- create exactly one state successor with policy hash unchanged;
- increment nonce and occurrence_count by exactly one;
- set next_valid_after to max(previous next-valid, verified time) plus cadence;
- set remaining to input minus exact payout and, for native CKB only, permitted
  group-funded fee; and
- reject any other value leaving the V2 group.

Operator authority cannot change owner, recipient, asset, caps, cadence,
occurrence limit, expiry, fee ceiling, state type, or multisig.

### Owner Top-Up

Requires owner_lock_hash authorization. It may increase remaining but cannot
exceed total_cap_atomic. It increments nonce exactly once and preserves policy,
status, occurrence count, next-valid time, and all existing assets. Fees are
funded outside the V2 group.

### Owner Revoke

Requires owner authorization. It creates one successor with status revoked,
increments nonce exactly once, and preserves every asset and counter. Operator
payout is permanently disabled for that state. Owner reclaim remains valid.

### Owner Full Reclaim

Requires owner authorization and consumes the state with no V2 successor.
Every remaining UDT is transferred to owner_lock_hash. For native CKB, the net
owner increase equals all V2 input capacity minus the bounded transaction fee,
after subtracting any owner auth inputs and change. Operator authorization is
not required.

### Owner Migration

Requires owner authorization and consumes the state with no V2 successor.
Every remaining asset goes only to a target lock committed in the signed
transaction. Migration cannot be operator-only. A new V2 state is created under
the target implementation as a separate validated creation, and backend credit
moves only after both old consumption and new confirmation are observed.

Legacy v1 cells cannot gain owner authority retroactively. Their existing
operator migration path remains testnet-only, must send directly to the
owner-bound V2 address, and requires an exactly-once backend migration record.

## Time Evidence Mainnet Blocker

CKB since proves that an input is not committed before a lower bound. A spender
can still use an old lower-bound value after wall-clock expiry, so since alone
does not prove an upper-bound expiry or fresh cadence timestamp.

The reference model therefore accepts verifiedTimeSeconds as an abstract
consensus input, but no production implementation may do so until maintainers
approve a concrete non-replayable construction. Candidate designs requiring
review are:

- a canonical time-oracle cell with anti-replay state and acceptable
  availability/trust assumptions;
- a protocol-native header or epoch construction that scripts can prove fresh;
  or
- removing wall-clock expiry/cadence from operator authority and using only
  occurrence caps plus explicit owner revocation.

A signed timestamp or arbitrary header dep is insufficient if the operator can
replay pre-expiry evidence. BE-11 is blocked until this is resolved.

## Valid And Invalid Transaction Examples

The executable vectors cover:

| Action | Valid example | Invalid examples |
| --- | --- | --- |
| Operator payout | Exact committed recipient, cap, fee, change, nonce, occurrence, cadence | Missing multisig, wrong recipient, mixed pass, over-cap amount, excess fee, stale time, expired time, wrong nonce/count/change |
| Owner top-up | Owner auth, exact added amount, total cap preserved | Operator-only top-up, payout side effect, total overflow, state counter change |
| Owner revoke | Owner auth, all assets unchanged, status revoked | Asset drain, fee from group, recipient output, counter mutation |
| Owner reclaim | Owner auth, no V2 successor, full owner net amount | Operator-only reclaim, wrong owner, leftover V2 asset, underpayment |
| Owner migration | Owner auth, full amount to signed target | Operator-only migration, target substitution, partial migration |
| UDT payout | Exact type hash and uint128 conservation | Symbol-only match, wrong type hash, mixed types, state capacity drain |

Run:

    npx tsx src/tests/vaultV2Model.test.ts
    npm test

BE-11 must add Molecule builder fixtures, ckb-testtool transactions,
ckb-debugger invalid vectors, cycle ceilings, testnet deployment hashes, owner
recovery drill, and independent audit.

## Mainnet Gates

No mainnet deposit address may be generated until all are true:

1. CKB/Fiber maintainers resolve the review questions and time evidence.
2. The exact Molecule schema and code hashes are frozen.
3. The Rust lock and state type scripts match every reference vector.
4. ckb-debugger and property/fuzz suites pass within a published cycle ceiling.
5. Owner JoyID reclaim and operator threshold multisig are tested on testnet.
6. An independent audit has no unresolved critical or high finding.
7. Legacy deposits are disabled and migration/recovery is rehearsed.
8. Deployment, rollback, key rotation, and incident procedures are public.
