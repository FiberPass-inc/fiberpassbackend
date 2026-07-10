import assert from 'node:assert/strict';
import {
  canTransitionBatch,
  canTransitionInvoice,
  canTransitionPaymentJob,
  isFinalBatchStatus,
  isFinalInvoiceStatus,
  isFinalPaymentJobStatus,
  validateAutomationSafetyEnvelope
} from '../domain/automation.js';
import {
  InvoiceModel,
  PaymentBatchModel,
  PaymentJobModel,
  RecipientModel
} from '../models/automation.model.js';
import { hashFiberInvoice, normalizeFiberInvoice } from '../services/automation.service.js';

assert.equal(canTransitionInvoice('draft', 'queued'), true);
assert.equal(canTransitionInvoice('queued', 'paid'), false);
assert.equal(canTransitionInvoice('processing', 'paid'), true);
assert.equal(canTransitionInvoice('paid', 'queued'), false);
assert.equal(isFinalInvoiceStatus('paid'), true);
assert.equal(isFinalInvoiceStatus('failed'), false);

assert.equal(canTransitionBatch('draft', 'queued'), true);
assert.equal(canTransitionBatch('processing', 'partial'), true);
assert.equal(canTransitionBatch('completed', 'processing'), false);
assert.equal(isFinalBatchStatus('completed'), true);
assert.equal(isFinalBatchStatus('failed'), false);

assert.equal(canTransitionPaymentJob('queued', 'locked'), true);
assert.equal(canTransitionPaymentJob('locked', 'processing'), true);
assert.equal(canTransitionPaymentJob('succeeded', 'queued'), false);
assert.equal(isFinalPaymentJobStatus('failed'), true);
assert.equal(isFinalPaymentJobStatus('retrying'), false);

assert.doesNotThrow(() => validateAutomationSafetyEnvelope({
  sessionId: 'fp_pass_test',
  appId: 'fp_app_test',
  ownerWalletId: 'ckt1owner',
  currency: 'CKB',
  maxAmountMinor: 1,
  allowAutomation: true,
  expiresAt: new Date(Date.now() + 60_000)
}));

assert.throws(() => validateAutomationSafetyEnvelope({
  sessionId: 'fp_pass_test',
  appId: 'fp_app_test',
  ownerWalletId: 'ckt1owner',
  currency: 'CKB',
  maxAmountMinor: 1,
  allowAutomation: false
}), /explicitly enabled/);

const recipientIndexes = RecipientModel.schema.indexes().map(([fields]) => fields);
assert.ok(recipientIndexes.some((fields) => Object.prototype.hasOwnProperty.call(fields, 'recipientId')));
assert.ok(recipientIndexes.some((fields) => Object.prototype.hasOwnProperty.call(fields, 'ownerWalletId') && Object.prototype.hasOwnProperty.call(fields, 'appId')));

const invoiceIndexes = InvoiceModel.schema.indexes().map(([fields]) => fields);
assert.ok(invoiceIndexes.some((fields) => Object.prototype.hasOwnProperty.call(fields, 'invoiceId')));
assert.ok(invoiceIndexes.some((fields) => Object.prototype.hasOwnProperty.call(fields, 'sessionId') && Object.prototype.hasOwnProperty.call(fields, 'status')));

const jobIndexes = PaymentJobModel.schema.indexes().map(([fields]) => fields);
assert.ok(jobIndexes.some((fields) => Object.prototype.hasOwnProperty.call(fields, 'invoiceId')));
assert.ok(jobIndexes.some((fields) => Object.prototype.hasOwnProperty.call(fields, 'status') && Object.prototype.hasOwnProperty.call(fields, 'runAfter')));

const batchIndexes = PaymentBatchModel.schema.indexes().map(([fields]) => fields);
assert.ok(batchIndexes.some((fields) => Object.prototype.hasOwnProperty.call(fields, 'batchId')));
assert.ok(batchIndexes.some((fields) => Object.prototype.hasOwnProperty.call(fields, 'sessionId') && Object.prototype.hasOwnProperty.call(fields, 'status')));

assert.equal(normalizeFiberInvoice('  fiber-payment-request  '), 'fiber-payment-request');
assert.equal(normalizeFiberInvoice('   '), undefined);
assert.equal(hashFiberInvoice('  invoice-one  '), hashFiberInvoice('invoice-one'));
assert.notEqual(hashFiberInvoice('invoice-one'), hashFiberInvoice('invoice-two'));

