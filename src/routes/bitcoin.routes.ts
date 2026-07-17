import { Router } from 'express';
import { z } from 'zod';
import { BITCOIN_NETWORKS, BTCPAY_SCOPE_TYPES } from '../domain/bitcoin.js';
import { ApiError } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  abandonBitcoinPsbt,
  createBitcoinPsbt,
  getBitcoinPsbt,
  submitSignedBitcoinPsbt
} from '../services/bitcoinPsbt.service.js';
import {
  createBtcpayInvoice,
  disconnectBtcpayConnection,
  getBtcpayInvoice,
  getBtcpayPayment,
  listBtcpayConnections,
  pairBtcpayConnection,
  payBtcpayLightning
} from '../services/btcpay.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const atomic = z.string().trim().regex(/^(0|[1-9]\d*)$/).max(78);
const idempotency = z.string().trim().min(8).max(160).optional();
const connectionParams = z.object({ connectionId: z.string().trim().min(8).max(100) });
const invoiceParams = connectionParams.extend({ invoiceId: z.string().trim().min(8).max(100) });
const paymentParams = connectionParams.extend({ paymentHash: z.string().trim().regex(/^[0-9a-fA-F]{64}$/) });
const psbtParams = z.object({ psbtId: z.string().trim().min(8).max(100) });

const pairSchema = z.object({
  serverUrl: z.string().trim().url().max(2048),
  storeId: z.string().trim().min(3).max(128),
  apiKey: z.string().trim().min(20).max(256),
  network: z.enum(BITCOIN_NETWORKS),
  scopeType: z.enum(BTCPAY_SCOPE_TYPES).default('wallet'),
  scopeId: z.string().trim().min(1).max(120).optional()
});
const disconnectSchema = z.object({ reason: z.string().trim().min(1).max(160).optional() });
const invoiceSchema = z.object({
  rail: z.enum(['lightning', 'bitcoin_onchain']),
  amountAtomic: atomic,
  idempotencyKey: idempotency
});
const paymentSchema = z.object({
  invoice: z.string().trim().min(20).max(8192),
  maxFeeAtomic: atomic,
  idempotencyKey: idempotency
});
const psbtCreateSchema = z.object({
  network: z.enum(BITCOIN_NETWORKS),
  scopeType: z.enum(BTCPAY_SCOPE_TYPES).default('wallet'),
  scopeId: z.string().trim().min(1).max(120).optional(),
  destination: z.string().trim().min(8).max(2048),
  amountAtomic: atomic,
  inputs: z.array(z.object({
    txid: z.string().trim().regex(/^[0-9a-fA-F]{64}$/),
    vout: z.number().int().nonnegative()
  })).max(50).default([]),
  changeAddress: z.string().trim().min(8).max(128),
  feeRateSatVb: atomic,
  maxFeeAtomic: atomic,
  minInputConfirmations: z.number().int().min(0).max(100).default(1),
  requiredConfirmations: z.number().int().min(1).max(100).default(1),
  replacesPsbtId: z.string().trim().min(8).max(100).optional(),
  idempotencyKey: idempotency
});
const psbtSubmitSchema = z.object({ signedPsbt: z.string().trim().min(16).max(300000) });

function idempotencyKey(request: Parameters<Parameters<typeof asyncHandler>[0]>[0], bodyValue?: string): string {
  const value = bodyValue ?? request.header('idempotency-key')?.trim();
  if (!value || value.length < 8 || value.length > 160) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Request requires an idempotency key between 8 and 160 characters.');
  }
  return value;
}

export const bitcoinRouter = Router();

bitcoinRouter.get('/wallet/btcpay-connections', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json(await listBtcpayConnections(walletId));
}));

bitcoinRouter.post('/wallet/btcpay-connections', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.status(201).json(await pairBtcpayConnection(pairSchema.parse(request.body ?? {}), walletId));
}));

bitcoinRouter.delete('/wallet/btcpay-connections/:connectionId', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { connectionId } = connectionParams.parse(request.params);
  const { reason } = disconnectSchema.parse(request.body ?? {});
  response.json(await disconnectBtcpayConnection(connectionId, walletId, reason));
}));

bitcoinRouter.post('/wallet/btcpay-connections/:connectionId/invoices', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { connectionId } = connectionParams.parse(request.params);
  const body = invoiceSchema.parse(request.body ?? {});
  response.status(201).json(await createBtcpayInvoice({
    connectionId,
    ownerWalletId: walletId,
    rail: body.rail,
    amountAtomic: body.amountAtomic,
    idempotencyKey: idempotencyKey(request, body.idempotencyKey)
  }));
}));

bitcoinRouter.get('/wallet/btcpay-connections/:connectionId/invoices/:invoiceId', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { connectionId, invoiceId } = invoiceParams.parse(request.params);
  response.json(await getBtcpayInvoice({ connectionId, invoiceId, ownerWalletId: walletId }));
}));

bitcoinRouter.post('/wallet/btcpay-connections/:connectionId/lightning-payments', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { connectionId } = connectionParams.parse(request.params);
  const body = paymentSchema.parse(request.body ?? {});
  const result = await payBtcpayLightning({
    connectionId,
    ownerWalletId: walletId,
    invoice: body.invoice,
    maxFeeAtomic: body.maxFeeAtomic,
    idempotencyKey: idempotencyKey(request, body.idempotencyKey)
  });
  response.status(result.status === 'pending' || result.status === 'uncertain' ? 202 : 200).json(result);
}));

bitcoinRouter.get('/wallet/btcpay-connections/:connectionId/lightning-payments/:paymentHash', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { connectionId, paymentHash } = paymentParams.parse(request.params);
  const result = await getBtcpayPayment({ connectionId, paymentHash, ownerWalletId: walletId });
  response.status(result.status === 'pending' || result.status === 'uncertain' ? 202 : 200).json(result);
}));

bitcoinRouter.post('/wallet/bitcoin/psbts', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const body = psbtCreateSchema.parse(request.body ?? {});
  response.status(201).json(await createBitcoinPsbt({
    ...body,
    ownerWalletId: walletId,
    inputs: body.inputs.map((input) => ({ txid: input.txid.toLowerCase(), vout: input.vout })),
    idempotencyKey: idempotencyKey(request, body.idempotencyKey)
  }));
}));

bitcoinRouter.get('/wallet/bitcoin/psbts/:psbtId', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { psbtId } = psbtParams.parse(request.params);
  response.json(await getBitcoinPsbt({ psbtId, ownerWalletId: walletId }));
}));

bitcoinRouter.post('/wallet/bitcoin/psbts/:psbtId/submit', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { psbtId } = psbtParams.parse(request.params);
  const { signedPsbt } = psbtSubmitSchema.parse(request.body ?? {});
  const result = await submitSignedBitcoinPsbt({ psbtId, ownerWalletId: walletId, signedPsbt });
  response.status(result.status === 'confirmed' ? 200 : 202).json(result);
}));

bitcoinRouter.post('/wallet/bitcoin/psbts/:psbtId/abandon', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { psbtId } = psbtParams.parse(request.params);
  response.json(await abandonBitcoinPsbt({ psbtId, ownerWalletId: walletId }));
}));
