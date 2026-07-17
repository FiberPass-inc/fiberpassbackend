import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { PAYMENT_CONTRACT_VERSION, type PaymentRail } from '../domain/payment.js';
import { hashReceipt, type ReceiptSourceType, type ReceiptStatus } from '../domain/receipt.js';
import { asAtomicAmount } from '../lib/money.js';
import { NotificationEndpointModel } from '../models/identity.model.js';
import {
  NotificationDeliveryModel,
  PaymentReceiptModel,
  type PaymentReceiptRecord
} from '../models/receipt.model.js';

export interface CreatePaymentReceiptInput {
  ownerWalletId: string;
  recipientId?: string;
  sourceType: ReceiptSourceType;
  sourceId: string;
  settlementId: string;
  rail: PaymentRail;
  network: string;
  assetId: string;
  amountAtomic: string;
  feeAtomic?: string;
  status: ReceiptStatus;
  paymentHash?: string;
  proofKind?: string;
  proofReference?: string;
  settledAt: Date;
}

export interface PaymentReceiptDto {
  contractVersion: typeof PAYMENT_CONTRACT_VERSION;
  id: string;
  hash: string;
  version: 1;
  source: { type: string; id: string };
  settlementId: string;
  recipientId?: string;
  rail: string;
  network: string;
  assetId: string;
  amountAtomic: string;
  fee: { amountAtomic: string; known: boolean };
  status: string;
  paymentHash?: string;
  proof?: { kind: string; reference: string };
  settledAt: string;
  createdAt: string;
}

function receiptIdFor(sourceType: ReceiptSourceType, sourceId: string): string {
  return 'rcpt_' + createHash('sha256').update(sourceType + '|' + sourceId).digest('hex');
}

function deliveryIdFor(receiptId: string, endpointId: string): string {
  return 'ndlv_' + createHash('sha256').update(receiptId + '|' + endpointId).digest('hex');
}

export function paymentReceiptDto(receipt: PaymentReceiptRecord & { createdAt?: Date }): PaymentReceiptDto {
  return {
    contractVersion: PAYMENT_CONTRACT_VERSION,
    id: receipt.receiptId,
    hash: receipt.receiptHash,
    version: 1,
    source: { type: receipt.sourceType, id: receipt.sourceId },
    settlementId: receipt.settlementId,
    recipientId: receipt.recipientId ?? undefined,
    rail: receipt.rail,
    network: receipt.network,
    assetId: receipt.assetId,
    amountAtomic: receipt.amountAtomic,
    fee: { amountAtomic: receipt.feeAtomic, known: receipt.feeKnown },
    status: receipt.status,
    paymentHash: receipt.paymentHash ?? undefined,
    proof: receipt.proofKind && receipt.proofReference
      ? { kind: receipt.proofKind, reference: receipt.proofReference }
      : undefined,
    settledAt: receipt.settledAt.toISOString(),
    createdAt: (receipt.createdAt ?? receipt.settledAt).toISOString()
  };
}

export async function createPaymentReceipt(
  input: CreatePaymentReceiptInput,
  session: ClientSession
): Promise<string> {
  const receiptId = receiptIdFor(input.sourceType, input.sourceId);
  const amountAtomic = asAtomicAmount(input.amountAtomic);
  const feeKnown = input.feeAtomic != null;
  const feeAtomic = asAtomicAmount(input.feeAtomic ?? '0');
  const hashInput = {
    version: 1 as const,
    receiptId,
    ownerWalletId: input.ownerWalletId,
    recipientId: input.recipientId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    settlementId: input.settlementId,
    rail: input.rail,
    network: input.network,
    assetId: input.assetId,
    amountAtomic,
    feeAtomic,
    feeKnown,
    status: input.status,
    paymentHash: input.paymentHash,
    proofKind: input.proofKind,
    proofReference: input.proofReference,
    settledAt: input.settledAt
  };
  const receiptHash = hashReceipt(hashInput);
  const existing = await PaymentReceiptModel.findOne({
    sourceType: input.sourceType,
    sourceId: input.sourceId
  }).session(session).lean<PaymentReceiptRecord | null>();
  if (existing) {
    if (existing.receiptHash !== receiptHash) {
      throw new Error('Immutable receipt source was reused with different settlement data.');
    }
    return existing.receiptId;
  }
  await PaymentReceiptModel.create([{
    ...hashInput,
    receiptHash,
    moneyContractVersion: 2
  }], { session });
  return receiptId;
}

export async function queueReceiptNotifications(receiptId: string): Promise<number> {
  const receipt = await PaymentReceiptModel.findOne({ receiptId }).lean<PaymentReceiptRecord | null>();
  if (!receipt || !receipt.recipientId) return 0;
  const endpoints = await NotificationEndpointModel.find({
    ownerWalletId: receipt.ownerWalletId,
    recipientId: receipt.recipientId,
    purpose: 'receipt',
    status: 'active'
  }).select({ endpointId: 1, type: 1 }).lean();
  if (endpoints.length === 0) return 0;
  const now = new Date();
  const result = await NotificationDeliveryModel.bulkWrite(endpoints.map((endpoint) => ({
    updateOne: {
      filter: { receiptId, endpointId: endpoint.endpointId },
      update: {
        $setOnInsert: {
          deliveryId: deliveryIdFor(receiptId, endpoint.endpointId),
          receiptId,
          endpointId: endpoint.endpointId,
          ownerWalletId: receipt.ownerWalletId,
          channel: endpoint.type,
          status: 'queued' as const,
          attempts: 0,
          maxAttempts: 5,
          runAfter: now
        }
      },
      upsert: true
    }
  })), { ordered: false });
  return result.upsertedCount;
}

export async function listPaymentReceipts(ownerWalletId: string, limit = 100): Promise<PaymentReceiptDto[]> {
  const receipts = await PaymentReceiptModel.find({ ownerWalletId })
    .sort({ settledAt: -1, receiptId: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .lean<PaymentReceiptRecord[]>();
  return receipts.map(paymentReceiptDto);
}
