# FiberPass Vault Lock Testnet Deployment

Deployment date: 2026-07-09
Network: CKB testnet
Status: committed

## Transaction

- Transaction hash: `0xf1f804eb27c92f6656ceaaff4c80d7760f552e909024df8344ef70828ff358d0`
- Explorer: https://pudge.explorer.nervos.org/transaction/0xf1f804eb27c92f6656ceaaff4c80d7760f552e909024df8344ef70828ff358d0
- Block hash: `0x2a1efbb30bb5b76e9f730fcd1d42cd3c23ae750304d541c313915ce4c5fcc3ba`
- Cycles: `0x2845bf`

## Deployed Script

- Code hash: `0x547f90a8949221f8fbd389b49a339b2e4cba49288fe46b63b9ee4f5d0261f751`
- Hash type: `type`
- Code cell outpoint: `0xf1f804eb27c92f6656ceaaff4c80d7760f552e909024df8344ef70828ff358d0:0x0`
- Cell dep type: `code`

## Type ID

```json
{
  "codeHash": "0x00000000000000000000000000000000000000000000000000545950455f4944",
  "hashType": "type",
  "args": "0x9bc0a3d4a9633e356c0b9741480de9139dbfe985df2ed36088707a61c5f3d8fb"
}
```

## Addresses And Locks

- Deployer address: `ckt1qyqyl3dk9qxmaqs8f7lxqj97slcwtwmutkws7ns0mj`
- Initial operator address: `ckt1qyqyl3dk9qxmaqs8f7lxqj97slcwtwmutkws7ns0mj`
- Initial operator lock hash: `0x593325d587ddee3d804f1d18766dcb09a4e923491a0832d2630929c177a9f1d4`
- Operator lock script:

```json
{
  "codeHash": "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  "hashType": "type",
  "args": "0x4fc5b6280dbe82074fbe6048be87f0e5bb7c5d9d"
}
```

## Backend Env

```bash
FIBERPASS_VAULT_CODE_HASH=0x547f90a8949221f8fbd389b49a339b2e4cba49288fe46b63b9ee4f5d0261f751
FIBERPASS_VAULT_HASH_TYPE=type
FIBERPASS_OPERATOR_LOCK_HASH=0x593325d587ddee3d804f1d18766dcb09a4e923491a0832d2630929c177a9f1d4
```

## Notes

- This deployment uses Type ID, so backend vault addresses must use `hashType=type` and the deployed Type ID code hash above.
- The initial operator lock is the deployer wallet lock for testnet operation.
- The local private deployer wallet remains outside the repos under `.local-secrets/` and must not be committed.
