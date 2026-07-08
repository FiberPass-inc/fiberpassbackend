import assert from 'node:assert/strict';
import { MockFiberProvider } from '../services/fiberProvider.js';

const provider = new MockFiberProvider('testnet');
const created = await provider.createSession({
  localSessionId: 'session-1',
  walletId: 'wallet-1',
  appAddress: '0xapp',
  amountMinor: 1_000_000,
  currency: 'USDC'
});

assert.equal(created.provider, 'mock');
assert.equal(created.status, 'active');
assert.ok(created.networkSessionId.startsWith('mock_fiber_'));

const charge = await provider.authorizeCharge({
  sessionId: 'session-1',
  networkSessionId: created.networkSessionId,
  appAddress: '0xapp',
  amountMinor: 200_000,
  currency: 'USDC'
});
assert.equal(charge.authorized, true);
assert.ok(charge.proofId.startsWith('mock_charge_'));

const topUp = await provider.topUpSession({
  sessionId: 'session-1',
  networkSessionId: created.networkSessionId,
  walletId: 'wallet-1',
  amountMinor: 500_000,
  currency: 'USDC'
});
assert.ok(topUp.proofId.startsWith('mock_topup_'));

const settled = await provider.settleSession({
  sessionId: 'session-1',
  networkSessionId: created.networkSessionId,
  amountMinor: 1_300_000,
  currency: 'USDC',
  reason: 'settled'
});
assert.equal(settled.settled, true);

const status = await provider.getStatus('session-1', created.networkSessionId);
assert.equal(status.status, 'settled');
