import { randomUUID } from 'node:crypto';
import type { ResolverTransport } from '../connectors/destinationResolverClient.js';
import { paymentConnectorRegistry } from '../connectors/index.js';
import { asAssetId, moneyValue, type PaymentIntent, type PaymentRail } from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import { atomicAmountFromBigInt, parseAtomicAmount } from '../lib/money.js';
import { BtcpayPaymentModel } from '../models/bitcoin.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { PaymentDestinationModel, type PaymentDestinationRecord } from '../models/identity.model.js';
import {
  MeteredBatchModel,
  MeteredGrantModel,
  UsageEventModel,
  type MeteredBatchRecord,
  type MeteredGrantRecord
} from '../models/meteredPayment.model.js';
import { NwcPaymentModel } from '../models/nwc.model.js';
import { SessionModel } from '../models/session.model.js';
import { writeAuditLog } from './audit.service.js';
import { getBtcpayPayment, payBtcpayLightning } from './btcpay.service.js';
import { resolveFreshPaymentRequest } from './destinationResolver.service.js';
import { spendFundingAllocation } from './fundingSource.service.js';
import {
  releaseMeteredBatchReservation,
  safeMeteredAtomicNumber,
  sessionAtomic,
  setSessionAtomic
} from './meteredPayment.service.js';
import { getNwcPaymentStatus, payNwcInvoice } from './nwc.service.js';

const BATCH_LEASE_MS = 60_000;

export interface MeteredExecutionResult {
  status: 'succeeded' | 'pending' | 'failed';
  providerPaymentId?: string;
  paymentHash?: string;
  proofKind?: string;
  proofReference?: string;
  failureCode?: string;
  failureMessage?: string;
}

export interface MeteredExecutionInput {
  batchId: string;
  ownerWalletId: string;
  sessionId: string;
  rail: PaymentRail;
  network: string;
  assetId: string;
  executor: 'nwc' | 'btcpay' | 'fiber';
  connectionId?: string;
  amountAtomic: string;
  paymentRequest: string;
  paymentHash?: string;
}

export interface MeteredBatchExecutor {
  execute(
    input: MeteredExecutionInput,
    markSubmitted: (providerPaymentId?: string) => Promise<void>
  ): Promise<MeteredExecutionResult>;
  lookup(input: MeteredBatchRecord): Promise<MeteredExecutionResult | undefined>;
}

function paymentDtoResult(payment: {
  id: string;
  status: string;
  paymentHash: string;
  proof?: { kind: string; reference: string };
  failure?: { code: string; message?: string };
}): MeteredExecutionResult {
  return {
    status: payment.status === 'succeeded' ? 'succeeded' : payment.status === 'failed' ? 'failed' : 'pending',
    providerPaymentId: payment.id,
    paymentHash: payment.paymentHash,
    proofKind: payment.proof?.kind,
    proofReference: payment.proof?.reference,
    failureCode: payment.failure?.code,
    failureMessage: payment.failure?.message
  };
}

export const productionMeteredExecutor: MeteredBatchExecutor = {
  async execute(input, markSubmitted) {
    if (input.executor === 'nwc') {
      await markSubmitted();
      return paymentDtoResult(await payNwcInvoice({
        connectionId: input.connectionId ?? '',
        ownerWalletId: input.ownerWalletId,
        invoice: input.paymentRequest,
        idempotencyKey: input.batchId,
        executionMode: 'unattended'
      }));
    }
    if (input.executor === 'btcpay') {
      await markSubmitted();
      return paymentDtoResult(await payBtcpayLightning({
        connectionId: input.connectionId ?? '',
        ownerWalletId: input.ownerWalletId,
        invoice: input.paymentRequest,
        idempotencyKey: input.batchId,
        maxFeeAtomic: '0'
      }));
    }
    const intent: PaymentIntent = {
      intentId: input.batchId,
      idempotencyKey: input.batchId,
      rail: input.rail,
      network: input.network,
      money: moneyValue(input.assetId, input.amountAtomic),
      destination: {
        kind: 'invoice',
        rail: input.rail,
        network: input.network,
        value: input.paymentRequest
      },
      description: 'Metered usage batch'
    };
    const connector = paymentConnectorRegistry.require({
      rail: input.rail,
      network: input.network,
      assetId: asAssetId(input.assetId)
    });
    const quote = await connector.quote(intent);
    await markSubmitted(quote.metadata?.providerCorrelationId);
    const result = await connector.execute(intent, quote, {
      sessionId: input.sessionId,
      ownerWalletId: input.ownerWalletId
    });
    return {
      status: result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'pending',
      providerPaymentId: result.connectorReference ?? quote.metadata?.providerCorrelationId,
      proofKind: result.proof?.kind,
      proofReference: result.proof?.reference,
      failureCode: result.failureCode,
      failureMessage: result.failureMessage
    };
  },
  async lookup(batch) {
    if (batch.executor === 'nwc') {
      const stored = await NwcPaymentModel.findOne({
        ownerWalletId: batch.ownerWalletId,
        connectionId: batch.connectionId,
        idempotencyKey: batch.batchId
      }).lean();
      if (!stored) return undefined;
      return paymentDtoResult(await getNwcPaymentStatus({
        connectionId: stored.connectionId,
        ownerWalletId: stored.ownerWalletId,
        paymentHash: stored.paymentHash
      }));
    }
    if (batch.executor === 'btcpay') {
      const stored = await BtcpayPaymentModel.findOne({
        ownerWalletId: batch.ownerWalletId,
        connectionId: batch.connectionId,
        idempotencyKey: batch.batchId
      }).lean();
      if (!stored) return undefined;
      return paymentDtoResult(await getBtcpayPayment({
        connectionId: stored.connectionId,
        ownerWalletId: stored.ownerWalletId,
        paymentHash: stored.paymentHash
      }));
    }
    if (!batch.providerPaymentId) return undefined;
    const connector = paymentConnectorRegistry.require({
      rail: batch.rail,
      network: batch.network,
      assetId: asAssetId(batch.assetId)
    });
    const result = await connector.lookup({
      rail: batch.rail,
      network: batch.network,
      assetId: asAssetId(batch.assetId),
      reference: batch.providerPaymentId,
      ownerWalletId: batch.ownerWalletId
    });
    return {
      status: result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'pending',
      providerPaymentId: result.connectorReference,
      proofKind: result.proof?.kind,
      proofReference: result.proof?.reference,
      failureCode: result.failureCode,
      failureMessage: result.failureMessage
    };
  }
};

async function finalizeMeteredBatch(batchId: string, result: MeteredExecutionResult): Promise<void> {
  let audit: { walletId: string; grantId: string; totalAtomic: string; eventCount: number } | undefined;
  await MeteredBatchModel.db.transaction(async (mongoSession) => {
    const batch = await MeteredBatchModel.findOne({ batchId }).session(mongoSession);
    if (!batch || batch.status === 'succeeded') return;
    const events = await UsageEventModel.find({
      batchId,
      status: { $in: ['reserved', 'settling'] }
    }).session(mongoSession);
    const total = events.reduce((sum, event) => sum + parseAtomicAmount(event.amountAtomic), 0n);
    if (total !== parseAtomicAmount(batch.totalAtomic) || events.length !== batch.eventCount) {
      throw new Error('Metered batch event total does not match its immutable accounting total.');
    }
    const grant = await MeteredGrantModel.findOne({ grantId: batch.grantId }).session(mongoSession);
    const session = await SessionModel.findOne({ publicId: batch.sessionId }).session(mongoSession);
    if (!grant || !session) throw new Error('Metered settlement owner state is missing.');
    const grantReserved = parseAtomicAmount(grant.reservedAtomic);
    const grantSpent = parseAtomicAmount(grant.spentAtomic);
    const sessionRecord = session.toObject();
    const sessionReserved = sessionAtomic(sessionRecord, 'reserved');
    const sessionSpent = sessionAtomic(sessionRecord, 'spent');
    const sessionLimit = sessionAtomic(sessionRecord, 'limit');
    if (grantReserved < total || sessionReserved < total) {
      throw new Error('Metered settlement reservation is missing.');
    }
    grant.reservedAtomic = atomicAmountFromBigInt(grantReserved - total);
    grant.spentAtomic = atomicAmountFromBigInt(grantSpent + total);
    if (grantSpent + total >= parseAtomicAmount(grant.totalLimitAtomic) && grant.status === 'active') {
      grant.status = 'depleted';
    }
    setSessionAtomic(session, 'reserved', sessionReserved - total);
    setSessionAtomic(session, 'spent', sessionSpent + total);
    if (sessionSpent + total >= sessionLimit) session.status = 'expired';
    await spendFundingAllocation(
      batch.sessionId,
      safeMeteredAtomicNumber(total, 'Metered batch total'),
      mongoSession
    );
    await grant.save({ session: mongoSession });
    await session.save({ session: mongoSession });

    const now = new Date();
    const eventIds = events.map((event) => event.eventId);
    await UsageEventModel.updateMany(
      { eventId: { $in: eventIds } },
      {
        $set: {
          status: 'settled',
          settledAt: now,
          proofKind: result.proofKind,
          proofReference: result.proofReference,
          paymentRequestHash: batch.paymentRequestHash
        },
        $unset: { failureCode: 1, failureMessage: 1 }
      },
      { session: mongoSession }
    );
    await ChargeAttemptModel.updateMany(
      { attemptId: { $in: eventIds }, reserveStatus: 'reserved' },
      {
        $set: {
          status: 'succeeded',
          reserveStatus: 'debited',
          providerStatus: 'succeeded',
          provider: batch.executor,
          network: batch.network,
          providerCorrelationId: result.providerPaymentId,
          proofId: result.proofReference,
          proofType: result.proofKind,
          paymentRequestHash: batch.paymentRequestHash,
          finalizedAt: now,
          providerCompletedAt: now
        },
        $unset: { failureCode: 1, failureMessage: 1 }
      },
      { session: mongoSession }
    );
    batch.status = 'succeeded';
    batch.accepting = false;
    batch.completedAt = now;
    batch.providerPaymentId = result.providerPaymentId ?? batch.providerPaymentId;
    batch.paymentHash = result.paymentHash ?? batch.paymentHash;
    batch.proofKind = result.proofKind;
    batch.proofReference = result.proofReference;
    batch.failureCode = undefined;
    batch.failureMessage = undefined;
    batch.leaseId = undefined;
    batch.leaseExpiresAt = now;
    await batch.save({ session: mongoSession });
    audit = {
      walletId: batch.ownerWalletId,
      grantId: batch.grantId,
      totalAtomic: batch.totalAtomic,
      eventCount: batch.eventCount
    };
  });
  if (audit) {
    await writeAuditLog({
      actorWalletId: audit.walletId,
      action: 'metered.batch.succeeded',
      targetType: 'metered_batch',
      targetId: batchId,
      metadata: {
        grantId: audit.grantId,
        totalAtomic: audit.totalAtomic,
        eventCount: audit.eventCount,
        proofReference: result.proofReference
      }
    });
  }
}

async function claimMeteredBatch(now: Date, workerId: string): Promise<MeteredBatchRecord | null> {
  return MeteredBatchModel.findOneAndUpdate(
    {
      status: { $in: ['collecting', 'queued', 'processing', 'uncertain', 'retrying'] },
      runAfter: { $lte: now },
      $or: [
        { leaseExpiresAt: { $lte: now } },
        { leaseExpiresAt: { $exists: false } }
      ]
    },
    {
      $set: {
        status: 'processing',
        accepting: false,
        leaseId: workerId + ':' + randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + BATCH_LEASE_MS)
      },
      $inc: { attempts: 1 }
    },
    { new: true, sort: { runAfter: 1, createdAt: 1 } }
  ).lean<MeteredBatchRecord | null>();
}

function publicFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.statusCode >= 500
        || error.code.includes('TIMEOUT')
        || error.code.includes('UNCERTAIN')
        || error.code.includes('UNAVAILABLE')
    };
  }
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 11000) {
    return {
      code: 'METERED_PAYMENT_REQUEST_REUSED',
      message: 'Resolver returned a payment request already assigned to another batch.',
      retryable: true
    };
  }
  return {
    code: 'METERED_SETTLEMENT_FAILED',
    message: error instanceof Error ? error.message : 'Metered settlement failed.',
    retryable: true
  };
}

async function retryMeteredBatch(
  batch: MeteredBatchRecord,
  failure: { code: string; message: string },
  submitted = Boolean(batch.submittedAt)
): Promise<void> {
  const now = new Date();
  const delay = Math.min(60_000, 1000 * (2 ** Math.min(Math.max(batch.attempts - 1, 0), 6)));
  await MeteredBatchModel.updateOne(
    { batchId: batch.batchId, leaseId: batch.leaseId },
    {
      $set: {
        status: submitted ? 'uncertain' : 'retrying',
        runAfter: new Date(now.getTime() + delay),
        leaseExpiresAt: now,
        failureCode: failure.code,
        failureMessage: failure.message
      },
      $unset: { leaseId: 1 }
    }
  );
}

export interface MeteredWorkerResult {
  claimed: number;
  succeeded: number;
  pending: number;
  retried: number;
  released: number;
  skipped: number;
}

export async function runMeteredPaymentWorker(input: {
  limit?: number;
  workerId?: string;
  now?: Date;
  executor?: MeteredBatchExecutor;
  resolverTransport?: ResolverTransport;
} = {}): Promise<MeteredWorkerResult> {
  const now = input.now ?? new Date();
  const workerId = input.workerId?.trim() || 'metered-payment-worker';
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 10)));
  const executor = input.executor ?? productionMeteredExecutor;
  const output: MeteredWorkerResult = {
    claimed: 0,
    succeeded: 0,
    pending: 0,
    retried: 0,
    released: 0,
    skipped: 0
  };

  for (let index = 0; index < limit; index += 1) {
    const batch = await claimMeteredBatch(now, workerId);
    if (!batch) break;
    output.claimed += 1;
    try {
      const grant = await MeteredGrantModel.findOne({ grantId: batch.grantId }).lean<MeteredGrantRecord | null>();
      if (!grant) {
        throw new ApiError(409, 'METERED_GRANT_NOT_FOUND', 'Metered grant for this batch no longer exists.');
      }
      if ((grant.status === 'revoked' || grant.status === 'expired') && !batch.submittedAt) {
        await releaseMeteredBatchReservation(
          batch.batchId,
          'METERED_GRANT_INACTIVE',
          'Grant became inactive before batch submission.'
        );
        output.released += 1;
        continue;
      }
      if (batch.submittedAt) {
        const recovered = await executor.lookup(batch);
        if (recovered?.status === 'succeeded') {
          await finalizeMeteredBatch(batch.batchId, recovered);
          output.succeeded += 1;
          continue;
        }
        if (recovered?.status === 'pending') {
          await retryMeteredBatch(batch, {
            code: 'METERED_SETTLEMENT_UNCERTAIN',
            message: 'Provider settlement remains pending reconciliation.'
          }, true);
          output.pending += 1;
          continue;
        }
        if (recovered?.status === 'failed') {
          await releaseMeteredBatchReservation(
            batch.batchId,
            recovered.failureCode ?? 'METERED_SETTLEMENT_FAILED',
            recovered.failureMessage ?? 'Provider reports settlement failure.',
            'failed'
          );
          output.released += 1;
          continue;
        }
      }

      const destination = await PaymentDestinationModel.findOne({
        destinationId: batch.destinationId,
        recipientId: batch.recipientId,
        ownerWalletId: batch.ownerWalletId,
        status: 'active',
        reusable: true
      }).lean<PaymentDestinationRecord | null>();
      if (!destination) {
        throw new ApiError(409, 'METERED_DESTINATION_INACTIVE', 'Metered destination is no longer active.');
      }
      if (
        destination.rail !== batch.rail
        || destination.network !== batch.network
        || destination.assetId !== batch.assetId
      ) {
        throw new ApiError(409, 'METERED_DESTINATION_MISMATCH', 'Metered destination no longer matches its batch.');
      }
      const resolved = await resolveFreshPaymentRequest({
        occurrenceId: batch.batchId,
        dueAt: batch.runAfter,
        destination: {
          destinationId: destination.destinationId,
          recipientId: destination.recipientId,
          rail: destination.rail as PaymentRail,
          network: destination.network,
          assetId: destination.assetId,
          kind: destination.kind,
          value: destination.value,
          resolverEndpoint: destination.resolverEndpoint ?? undefined
        },
        amountAtomic: batch.totalAtomic,
        now
      }, input.resolverTransport);
      const stored = await MeteredBatchModel.findOneAndUpdate(
        { batchId: batch.batchId, leaseId: batch.leaseId },
        { $set: { paymentRequestHash: resolved.paymentRequestHash, paymentHash: resolved.paymentHash } },
        { new: true }
      ).lean<MeteredBatchRecord | null>();
      if (!stored) {
        output.skipped += 1;
        continue;
      }
      await UsageEventModel.updateMany(
        { batchId: batch.batchId, status: 'reserved' },
        { $set: { status: 'settling', settlingAt: now } }
      );
      let submitted = false;
      const markSubmitted = async (providerPaymentId?: string): Promise<void> => {
        await MeteredBatchModel.updateOne(
          { batchId: batch.batchId, leaseId: batch.leaseId },
          {
            $set: {
              submittedAt: new Date(),
              ...(providerPaymentId ? { providerPaymentId } : {})
            }
          }
        );
        submitted = true;
      };
      const result = await executor.execute({
        batchId: batch.batchId,
        ownerWalletId: batch.ownerWalletId,
        sessionId: batch.sessionId,
        rail: batch.rail,
        network: batch.network,
        assetId: batch.assetId,
        executor: batch.executor,
        connectionId: batch.connectionId ?? undefined,
        amountAtomic: batch.totalAtomic,
        paymentRequest: resolved.paymentRequest,
        paymentHash: resolved.paymentHash
      }, markSubmitted);
      if (result.status === 'succeeded') {
        await finalizeMeteredBatch(batch.batchId, result);
        output.succeeded += 1;
      } else if (result.status === 'failed') {
        await releaseMeteredBatchReservation(
          batch.batchId,
          result.failureCode ?? 'METERED_SETTLEMENT_FAILED',
          result.failureMessage ?? 'Provider rejected settlement.',
          'failed'
        );
        output.released += 1;
      } else {
        await retryMeteredBatch(batch, {
          code: 'METERED_SETTLEMENT_UNCERTAIN',
          message: 'Provider settlement requires reconciliation.'
        }, submitted);
        output.pending += 1;
      }
    } catch (error) {
      const failure = publicFailure(error);
      const current = await MeteredBatchModel.findOne({ batchId: batch.batchId }).lean<MeteredBatchRecord | null>();
      const submitted = Boolean(current?.submittedAt);
      if (failure.retryable && batch.attempts < batch.maxAttempts) {
        await retryMeteredBatch(batch, failure, submitted);
        output.retried += 1;
      } else {
        await releaseMeteredBatchReservation(batch.batchId, failure.code, failure.message, 'failed');
        output.released += 1;
      }
    }
  }
  return output;
}
