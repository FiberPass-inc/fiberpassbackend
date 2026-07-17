export const RECIPIENT_STATUSES = ['active', 'disabled'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const AUTOMATION_PAYMENT_STATUSES = ['draft', 'queued', 'processing', 'paid', 'failed', 'cancelled'] as const;
export type AutomationPaymentStatus = (typeof AUTOMATION_PAYMENT_STATUSES)[number];

export const PAYMENT_BATCH_STATUSES = ['draft', 'queued', 'processing', 'partial', 'completed', 'failed', 'cancelled'] as const;
export type PaymentBatchStatus = (typeof PAYMENT_BATCH_STATUSES)[number];

export const PAYMENT_JOB_STATUSES = ['queued', 'locked', 'processing', 'succeeded', 'retrying', 'failed', 'cancelled'] as const;
export type PaymentJobStatus = (typeof PAYMENT_JOB_STATUSES)[number];

export const AUTOMATION_AUDIT_ACTIONS = {
  recipientCreated: 'automation.recipient.created',
  recipientUpdated: 'automation.recipient.updated',
  recipientDisabled: 'automation.recipient.disabled',
  invoiceCreated: 'automation.invoice.created',
  invoiceQueued: 'automation.invoice.queued',
  invoicePaid: 'automation.invoice.paid',
  invoiceFailed: 'automation.invoice.failed',
  invoiceCancelled: 'automation.invoice.cancelled',
  batchCreated: 'automation.batch.created',
  batchQueued: 'automation.batch.queued',
  batchCompleted: 'automation.batch.completed',
  batchFailed: 'automation.batch.failed',
  batchCancelled: 'automation.batch.cancelled',
  jobQueued: 'automation.job.queued',
  jobLocked: 'automation.job.locked',
  jobSucceeded: 'automation.job.succeeded',
  jobRetrying: 'automation.job.retrying',
  jobFailed: 'automation.job.failed'
} as const;

export const INVOICE_STATUS_TRANSITIONS: Record<AutomationPaymentStatus, AutomationPaymentStatus[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['processing', 'failed', 'cancelled'],
  processing: ['paid', 'failed', 'queued', 'cancelled'],
  paid: [],
  failed: ['queued', 'cancelled'],
  cancelled: []
};

export const BATCH_STATUS_TRANSITIONS: Record<PaymentBatchStatus, PaymentBatchStatus[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['processing', 'failed', 'cancelled'],
  processing: ['partial', 'completed', 'failed', 'cancelled'],
  partial: ['processing', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: []
};

export const JOB_STATUS_TRANSITIONS: Record<PaymentJobStatus, PaymentJobStatus[]> = {
  queued: ['locked', 'failed', 'cancelled'],
  locked: ['processing', 'queued', 'failed', 'cancelled'],
  processing: ['succeeded', 'retrying', 'failed', 'cancelled'],
  succeeded: [],
  retrying: ['queued', 'failed', 'cancelled'],
  failed: [],
  cancelled: []
};

type TransitionMap<TStatus extends string> = Record<TStatus, readonly TStatus[]>;

export function canTransition<TStatus extends string>(transitions: TransitionMap<TStatus>, from: TStatus, to: TStatus): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function canTransitionInvoice(from: AutomationPaymentStatus, to: AutomationPaymentStatus): boolean {
  return canTransition(INVOICE_STATUS_TRANSITIONS, from, to);
}

export function canTransitionBatch(from: PaymentBatchStatus, to: PaymentBatchStatus): boolean {
  return canTransition(BATCH_STATUS_TRANSITIONS, from, to);
}

export function canTransitionPaymentJob(from: PaymentJobStatus, to: PaymentJobStatus): boolean {
  return canTransition(JOB_STATUS_TRANSITIONS, from, to);
}

export function isFinalInvoiceStatus(status: AutomationPaymentStatus): boolean {
  return status === 'paid' || status === 'cancelled';
}

export function isFinalBatchStatus(status: PaymentBatchStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

export function isFinalPaymentJobStatus(status: PaymentJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export interface AutomationSafetyEnvelope {
  sessionId: string;
  appId: string;
  ownerWalletId: string;
  assetId: AssetId;
  maxAmountAtomic: AtomicAmount;
  expiresAt?: Date;
  allowAutomation: boolean;
}

export function validateAutomationSafetyEnvelope(envelope: AutomationSafetyEnvelope): void {
  if (!envelope.allowAutomation) {
    throw new Error('Automation must be explicitly enabled for this FiberPass session.');
  }

  if (parseAtomicAmount(envelope.maxAmountAtomic) <= 0n) {
    throw new Error('Automation max amount must be a positive atomic-unit integer string.');
  }

  if (envelope.expiresAt && envelope.expiresAt.getTime() <= Date.now()) {
    throw new Error('Automation cannot run against an expired FiberPass session.');
  }
}
import type { AssetId } from './payment.js';
import { parseAtomicAmount, type AtomicAmount } from '../lib/money.js';
