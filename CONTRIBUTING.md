# Contributing to FiberPass Backend

FiberPass welcomes focused bug fixes, tests, documentation, and implementation
work from the public backlog in `TASKS.md`.

## Before You Start

1. Search existing issues and pull requests.
2. Open or claim one issue with a clear outcome and acceptance checklist.
3. Discuss architecture or public API changes in the issue before coding.
4. Report security problems privately according to `SECURITY.md`.

## Change Workflow

Create one short-lived branch per issue from the latest `main`. Keep commits
attributable to the GitHub account doing the implementation. Open a pull request
that links the issue, explains behavior and migration impact, and lists the
commands used for validation.

At least one maintainer who did not implement the change must review it. The
reviewer checks the issue acceptance criteria, tests, security boundaries,
documentation, and backwards compatibility before merging. Do not push feature
work directly to `main`, merge your own pull request, or combine unrelated tasks
in one pull request.

## Local Validation

Install Node.js 22 and dependencies, then run:

```bash
npm ci
npm run lint
npm run build
npm test
```

Changes to persistence, workers, or the CKB testnet contract must also run the
relevant integration or contract command from `package.json`. Never weaken a
check solely to make a pull request pass.

## Engineering Rules

- Store money as atomic-unit integer strings at system boundaries and checked
  integers internally. Do not use floating-point arithmetic for money.
- Never commit or log wallet seeds, private keys, bearer tokens, NWC connection
  strings, invoices, preimages, email claim tokens, or production data.
- Keep chain and payment-protocol behavior behind connector boundaries.
- Preserve idempotency, authorization, audit, retry, and recovery semantics for
  every externally triggered mutation.
- State whether a feature is implemented, test-only, or planned. Do not present
  a local fixture or demo as production proof.
- Add migrations and compatibility behavior for persisted or public contract
  changes.

By contributing, you agree that your contribution is licensed under the Apache
License 2.0.
