# Security Policy

## Reporting a Vulnerability

Do not open a public issue, pull request, discussion, or Telegram message for a
suspected vulnerability. Use GitHub's private vulnerability reporting flow in
the repository Security tab. If that flow is unavailable, contact a FiberPass
organization owner privately and ask for a secure reporting channel without
including exploit details in the first message.

Include affected versions or commits, impact, reproduction prerequisites, and a
minimal proof of concept that contains no real credentials or user data. The
maintainers will acknowledge receipt, establish a private remediation thread,
and coordinate disclosure after a fix is available. Please do not test against
production systems or access data that is not yours.

## Supported Versions

Security fixes target the current `main` branch while the project is
pre-release. Tagged support windows will be documented when stable releases
begin.

## Sensitive Material

FiberPass never needs a user seed phrase or unrestricted wallet credential.
Revoke and rotate any credential accidentally committed or sent to a public
channel before reporting it. Repository history is not a secret store, even if
a later commit removes the value.

The CKB contract in `lockscripts/` is an unaudited testnet draft. It is not
approved for mainnet funds. A testnet deployment or passing CI is not a security
audit.
