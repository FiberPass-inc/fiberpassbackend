import assert from 'node:assert/strict';
import {
  PAYMENT_CONTRACT_VERSION,
  asAssetId,
  assetIdForLegacyCurrency,
  moneyValue,
  type PaymentIntent,
  type PaymentResult
} from '../domain/payment.js';
import { asAtomicAmount } from '../lib/money.js';

assert.equal(PAYMENT_CONTRACT_VERSION, '2.0');
assert.equal(assetIdForLegacyCurrency('CKB'), 'ckb:ckb');
assert.equal(assetIdForLegacyCurrency('BTC'), 'bitcoin:btc');
assert.throws(() => asAssetId('CKB'), /namespace:reference/);

const intent: PaymentIntent = {
  intentId: 'intent-1',
  idempotencyKey: 'idempotency-1',
  rail: 'lightning',
  network: 'signet',
  money: moneyValue('bitcoin:btc', '9007199254740993'),
  destination: {
    kind: 'offer',
    rail: 'lightning',
    network: 'signet',
    value: 'offer-reference'
  }
};
assert.equal(intent.money.amountAtomic, '9007199254740993');

const result: PaymentResult = {
  intentId: intent.intentId,
  status: 'succeeded',
  amount: { assetId: asAssetId('bitcoin:btc'), amountAtomic: asAtomicAmount('9007199254740993') },
  connectorId: 'test-connector',
  proof: {
    kind: 'payment_hash',
    reference: 'hash-reference',
    observedAt: new Date(0).toISOString()
  },
  updatedAt: new Date(0).toISOString()
};
assert.equal(result.proof?.kind, 'payment_hash');
