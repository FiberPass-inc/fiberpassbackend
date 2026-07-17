# CKB/Fiber Maintainer Review Packet: Per-Pass Vault V2

Status: ready to request; no maintainer feedback has been received or claimed.

Task BE-10 requires feedback from CKB/Fiber maintainers before implementation.
This file is the review packet and permanent response record. Publishing it
does not substitute for external review.

## Review Artifacts

- Normative specification: ckb-per-pass-vault-v2-spec.md
- Threat model: ckb-per-pass-vault-v2-threat-model.md
- Reference model: ../src/domain/vaultV2.ts
- Valid/invalid vectors: ../src/tests/vaultV2Model.test.ts
- Existing v1 draft: ../lockscripts/fiberpass-vault-lock

## Requested Reviewers

At least:

- one CKB script/runtime or system-script maintainer;
- one Molecule/CKB SDK maintainer;
- one xUDT or CKB asset-script maintainer; and
- one Fiber maintainer familiar with payment settlement transaction shapes.

Named reviewers, organization, contact route, request date, and response URL
must be recorded below only after contact is authorized and performed.

## Questions Requiring Written Answers

1. Is one V2 lock group per transaction the correct way to prevent two script
   groups from counting one shared recipient output?
2. Is a Type ID-style companion state type the preferred creation/uniqueness
   mechanism, or should the state use another canonical CKB pattern?
3. Can a lock safely prove both cadence not-before and operator expiry
   not-after without a trusted stateful time oracle? If yes, what exact
   consensus-visible evidence is non-replayable?
4. Does the native CKB net-flow rule correctly account for auth inputs,
   recipient inputs, occupied capacity, and transaction fee?
5. For sUDT/xUDT, should the lock sum the first 16 little-endian data bytes
   directly, spawn the type script, or rely on type-script conservation plus
   its own destination check?
6. Is preserving state-cell CKB capacity and funding UDT transaction fees
   outside the V2 group the safest rule?
7. Can the existing JoyID lock participate as an auth input without introducing
   witness-group or signing ambiguity?
8. Which reviewed multisig lock and witness format should operator_lock_hash
   commit to, and how should threshold key rotation occur without weakening
   policy?
9. Are the proposed Molecule table fields and u128/u64 encodings canonical and
   forward-compatible enough for audit?
10. Which ckb-testtool, ckb-debugger, fuzzing, and cycle-limit gates should BE-11
    treat as mandatory?
11. Does the owner-only migration shape preserve full native and UDT value
    without enabling target substitution?
12. Which additional cell-dep, header-dep, DAO, ACP, xUDT extension, or SSRI
    interactions must be explicitly rejected?

## Response Record

| Date | Reviewer | Area | Source URL | Decision | Required change | Resolution commit |
| --- | --- | --- | --- | --- | --- | --- |
| Pending | Pending | Time evidence | Pending | Mainnet blocker | Select or remove time policy | Pending |

Do not replace Pending with a person's name without a public response URL or a
verifiable signed review artifact.

## Decision Gate

BE-10 may close only when:

- the issue links to the published request;
- requested reviewers cover script/runtime, asset, and Fiber concerns;
- every required change is incorporated or explicitly rejected with rationale;
- no maintainer identifies an unresolved safety-critical flaw; and
- the time-evidence question has an implementation decision.

BE-11 must not begin lock implementation merely because local reference tests
pass.
