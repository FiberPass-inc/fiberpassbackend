import assert from 'node:assert/strict';
import { asAtomicAmount } from '../lib/money.js';
import {
  assertMeteredGrantLimits,
  meteredBatchKey,
  nextRateWindow
} from '../domain/meteredPayment.js';
import { asAssetId } from '../domain/payment.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import {
  MeteredBatchModel,
  MeteredGrantModel,
  MeteredRateCounterModel,
  UsageEventModel
} from '../models/meteredPayment.model.js';

const identity = {
  ownerWalletId: 'wallet-1',
  appId: 'app-1',
  grantId: 'grant-1',
  sessionId: 'pass-1',
  recipientId: 'recipient-1',
  destinationId: 'destination-1',
  rail: 'lightning' as const,
  network: 'regtest',
  assetId: asAssetId('bitcoin:btc'),
  executor: 'nwc' as const,
  connectionId: 'nwc-1'
};

const key = meteredBatchKey(identity);
assert.equal(key, meteredBatchKey({ ...identity }));
for (const variant of [
  { ...identity, ownerWalletId: 'wallet-2' },
  { ...identity, appId: 'app-2' },
  { ...identity, grantId: 'grant-2' },
  { ...identity, sessionId: 'pass-2' },
  { ...identity, recipientId: 'recipient-2' },
  { ...identity, destinationId: 'destination-2' },
  { ...identity, rail: 'fiber' as const, assetId: asAssetId('ckb:ckb'), executor: 'fiber' as const, connectionId: undefined },
  { ...identity, network: 'mainnet' },
  { ...identity, assetId: asAssetId('legacy:usd') },
  { ...identity, executor: 'btcpay' as const },
  { ...identity, connectionId: 'nwc-2' }
]) {
  assert.notEqual(key, meteredBatchKey(variant));
}

assert.doesNotThrow(() => assertMeteredGrantLimits({
  maxPerEventAtomic: asAtomicAmount('10'),
  totalLimitAtomic: asAtomicAmount('1000'),
  immediateThresholdAtomic: asAtomicAmount('50'),
  maxBatchAtomic: asAtomicAmount('200')
}));
assert.throws(() => assertMeteredGrantLimits({
  maxPerEventAtomic: asAtomicAmount('101'),
  totalLimitAtomic: asAtomicAmount('100'),
  immediateThresholdAtomic: asAtomicAmount('50'),
  maxBatchAtomic: asAtomicAmount('200')
}), /Per-event/);
assert.throws(() => assertMeteredGrantLimits({
  maxPerEventAtomic: asAtomicAmount('10'),
  totalLimitAtomic: asAtomicAmount('100'),
  immediateThresholdAtomic: asAtomicAmount('201'),
  maxBatchAtomic: asAtomicAmount('200')
}), /threshold/);

const rateWindow = nextRateWindow(new Date('2026-07-17T12:34:56.789Z'), 60);
assert.equal(rateWindow.start.toISOString(), '2026-07-17T12:34:00.000Z');
assert.equal(rateWindow.end.toISOString(), '2026-07-17T12:35:00.000Z');

assert.ok(ChargeAttemptModel.schema.path('executionLayer')?.options.enum.includes('lightning'));
assert.ok(MeteredGrantModel.schema.path('reservedAtomic'));
assert.ok(UsageEventModel.schema.path('receiptId'));
assert.ok(MeteredBatchModel.schema.path('totalAtomic'));
assert.ok(MeteredRateCounterModel.schema.path('windowStart'));

assert.ok(UsageEventModel.schema.indexes().some(([fields, options]) => (
  fields.appId === 1 && fields.externalId === 1 && options?.unique === true
)));
assert.ok(MeteredBatchModel.schema.indexes().some(([fields, options]) => (
  fields.batchKey === 1
  && fields.accepting === 1
  && options?.unique === true
  && options?.partialFilterExpression?.accepting === true
)));
assert.ok(MeteredBatchModel.schema.indexes().some(([fields, options]) => (
  fields.paymentRequestHash === 1 && options?.unique === true
)));
