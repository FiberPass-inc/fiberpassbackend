import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { unwrapEvent } from 'nostr-tools/nip17';
import { bytesToHex } from 'nostr-tools/utils';
import { allocateAtomicFee, hashReceipt } from '../domain/receipt.js';
import { NotificationEndpointModel } from '../models/identity.model.js';
import {
  NotificationDeliveryModel,
  PaymentReceiptModel,
  type PaymentReceiptRecord
} from '../models/receipt.model.js';
import {
  createNip17ReceiptEvent,
  createReceiptUnsubscribeToken,
  renderReceiptEmail,
  renderReceiptNostrMessage
} from '../services/notification.service.js';

const settledAt = new Date('2026-07-17T12:34:56.000Z');
const hashInput = {
  version: 1 as const,
  receiptId: 'rcpt_' + '1'.repeat(64),
  ownerWalletId: 'wallet-private-value',
  recipientId: 'recipient-1',
  sourceType: 'scheduled_occurrence' as const,
  sourceId: 'occurrence-1',
  settlementId: 'payment-1',
  rail: 'lightning',
  network: 'regtest',
  assetId: 'bitcoin:btc',
  amountAtomic: '2500000',
  feeAtomic: '21',
  feeKnown: true,
  status: 'succeeded' as const,
  paymentHash: '2'.repeat(64),
  proofKind: 'payment_hash',
  proofReference: '3'.repeat(64),
  settledAt
};

const receiptHash = hashReceipt(hashInput);
assert.match(receiptHash, /^[0-9a-f]{64}$/);
assert.equal(receiptHash, hashReceipt({ ...hashInput }));
assert.notEqual(receiptHash, hashReceipt({ ...hashInput, feeAtomic: '22' }));
assert.notEqual(receiptHash, hashReceipt({ ...hashInput, status: 'refunded' }));

assert.deepEqual(allocateAtomicFee('5', ['1', '2', '3']), ['1', '2', '2']);
assert.deepEqual(allocateAtomicFee('0', ['10', '20']), ['0', '0']);
assert.equal(allocateAtomicFee('999999999999999999999999', ['1', '1']).reduce((sum, value) => sum + BigInt(value), 0n), 999999999999999999999999n);
assert.throws(() => allocateAtomicFee('1.5', ['1']), /integer strings/);
assert.throws(() => allocateAtomicFee('1', ['0']), /positive settlement/);

const receipt = {
  ...hashInput,
  receiptHash,
  moneyContractVersion: 2,
  createdAt: settledAt
} as unknown as PaymentReceiptRecord & { createdAt: Date };
const endpointId = 'ntf_snapshot';
const unsubscribeToken = createReceiptUnsubscribeToken(endpointId);
const email = renderReceiptEmail(receipt, endpointId);
assert.equal(email.subject, 'FiberPass payment receipt ' + receipt.receiptId);
assert.equal(email.text, [
  'FiberPass payment receipt',
  '',
  'Status: succeeded',
  'Amount: 2500000 atomic units (bitcoin:btc)',
  'Fee: 21 atomic units',
  'Network: lightning / regtest',
  'Receipt: ' + receipt.receiptId,
  'Receipt hash: ' + receiptHash,
  'Network proof (payment_hash): ' + '3'.repeat(64),
  '',
  'Manage receipt notifications: http://localhost:3000/notifications/unsubscribe?token=' + encodeURIComponent(unsubscribeToken)
].join('\n'));
assert.equal(email.html, '<!doctype html><html><body><h1>FiberPass payment receipt</h1><dl>'
  + '<dt>Status</dt><dd>succeeded</dd>'
  + '<dt>Amount</dt><dd>2500000 atomic units (bitcoin:btc)</dd>'
  + '<dt>Fee</dt><dd>21 atomic units</dd>'
  + '<dt>Network</dt><dd>lightning / regtest</dd>'
  + '<dt>Receipt</dt><dd>' + receipt.receiptId + '</dd>'
  + '<dt>Receipt hash</dt><dd>' + receiptHash + '</dd>'
  + '<dt>Network proof (payment_hash)</dt><dd>' + '3'.repeat(64) + '</dd>'
  + '</dl><p><a href="http://localhost:3000/notifications/unsubscribe?token=' + encodeURIComponent(unsubscribeToken) + '">Manage receipt notifications</a></p></body></html>');

for (const rendered of [email.subject, email.text, email.html, renderReceiptNostrMessage(receipt)]) {
  assert.equal(rendered.includes(hashInput.ownerWalletId), false);
  assert.equal(rendered.toLowerCase().includes('preimage'), false);
  assert.equal(rendered.toLowerCase().includes('invoice'), false);
  assert.equal(rendered.toLowerCase().includes('credential'), false);
  assert.equal(rendered.toLowerCase().includes('seed'), false);
}
assert.equal(unsubscribeToken.includes('claim'), false);

const senderSecret = generateSecretKey();
const recipientSecret = generateSecretKey();
const nostrMessage = renderReceiptNostrMessage(receipt);
const wrapped = createNip17ReceiptEvent({
  senderSecretKey: bytesToHex(senderSecret),
  publicKey: getPublicKey(recipientSecret),
  relayUrl: 'wss://relay.example.com',
  message: nostrMessage
});
assert.equal(wrapped.kind, 1059);
assert.deepEqual(wrapped.tags, [['p', getPublicKey(recipientSecret)]]);
assert.equal(wrapped.content.includes(receipt.receiptId), false);
const rumor = unwrapEvent(wrapped, recipientSecret);
assert.equal(rumor.kind, 14);
assert.equal(rumor.pubkey, getPublicKey(senderSecret));
assert.equal(rumor.content, nostrMessage);

assert.equal(PaymentReceiptModel.schema.path('amountAtomic')?.options.immutable, true);
assert.equal(PaymentReceiptModel.schema.path('status')?.options.immutable, true);
assert.equal(PaymentReceiptModel.schema.path('proofReference')?.options.immutable, true);
assert.ok(PaymentReceiptModel.schema.indexes().some(([fields, options]) => (
  fields.sourceType === 1 && fields.sourceId === 1 && options?.unique === true
)));
assert.ok(NotificationDeliveryModel.schema.indexes().some(([fields, options]) => (
  fields.receiptId === 1 && fields.endpointId === 1 && options?.unique === true
)));
for (const forbiddenField of ['payload', 'content', 'message', 'value', 'token', 'invoice', 'preimage']) {
  assert.equal(NotificationDeliveryModel.schema.path(forbiddenField), undefined);
}
assert.ok(NotificationEndpointModel.schema.path('status')?.options.enum.includes('unsubscribed'));
