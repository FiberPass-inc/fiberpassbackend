import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { AppModel } from '../models/app.model.js';
import { AuthChallengeModel, AuthSessionModel } from '../models/auth.model.js';
import { InvoiceModel, PaymentBatchModel, PaymentJobModel, RecipientModel } from '../models/automation.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { PaymentDestinationModel, RecipientIdentityModel } from '../models/identity.model.js';
import { RateLimitBucketModel } from '../models/rateLimitBucket.model.js';
import { SessionModel } from '../models/session.model.js';
import { StreamTicketModel } from '../models/streamTicket.model.js';

const uri = process.env.PLATFORM_TEST_MONGODB_URI;
if (!uri) throw new Error('PLATFORM_TEST_MONGODB_URI is required for platform integration tests.');

process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';

const { createAuthChallenge, createStreamTicket, getAuthContextFromStreamTicket, getAuthContextFromToken, revokeAuthToken } = await import('../services/auth.service.js');
const { createInvoice, createRecipient, runPaymentWorkerOnce } = await import('../services/automation.service.js');
const { chargeSession, getCreateSessionPolicy } = await import('../services/session.service.js');
const { createRateLimitMiddleware } = await import('../middleware/rateLimit.middleware.js');
const { migrateLegacyMoneyToAtomicStrings } = await import('../migrations/atomicMoney.js');

const dbName = 'fiberpass_platform_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });
const { app } = await import('../app.js');

const walletAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const walletId = 'platform-wallet';
const appId = 'platform-app';
const sessionId = 'platform-session';

try {
  await Promise.all([
    AppModel.syncIndexes(),
    AuthChallengeModel.syncIndexes(),
    AuthSessionModel.syncIndexes(),
    RecipientModel.syncIndexes(),
    InvoiceModel.syncIndexes(),
    PaymentJobModel.syncIndexes(),
    PaymentBatchModel.syncIndexes(),
    PaymentDestinationModel.syncIndexes(),
    RecipientIdentityModel.syncIndexes(),
    RateLimitBucketModel.syncIndexes(),
    SessionModel.syncIndexes(),
    StreamTicketModel.syncIndexes()
  ]);
  const v2Meta = await request(app).get('/v2/meta').expect(200);
  assert.equal(v2Meta.headers['x-fiberpass-contract-version'], '2.0');
  assert.equal(v2Meta.body.contractVersion, '2.0');
  assert.equal(v2Meta.body.paymentContracts.amounts, 'canonical-atomic-unit-strings');

  const challenges = await Promise.all(Array.from({ length: 10 }, () => createAuthChallenge(walletAddress)));
  assert.equal(new Set(challenges.map((challenge) => challenge.challengeId)).size, 10);
  assert.equal(await AuthChallengeModel.countDocuments({ address: walletAddress }), 10);

  const token = 'platform-auth-token';
  await AuthSessionModel.create({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    walletId,
    address: walletAddress,
    expiresAt: new Date(Date.now() + 60_000)
  });
  const authContext = await getAuthContextFromToken(token);
  assert.deepEqual(authContext, { walletId, address: walletAddress });
  const connectorCapabilities = await request(app)
    .get('/v2/payment-connectors')
    .set('Authorization', 'Bearer ' + token)
    .expect(200);
  assert.equal(connectorCapabilities.body.contractVersion, '2.0');
  const capabilities = connectorCapabilities.body.capabilities as Array<{
    connectorId: string;
    rail: string;
    network: string;
    assetId: string;
    supportsLookup: boolean;
    funding: Array<{ mode: string; requiresNetworkProof: boolean }>;
  }>;
  assert.deepEqual(
    capabilities.map((capability) => capability.rail).sort(),
    ['ckb_onchain', 'fiber', 'lightning', 'lightning', 'lightning', 'lightning']
  );
  assert.deepEqual(
    capabilities
      .filter((capability) => capability.connectorId === 'nwc-nip47')
      .map((capability) => capability.network)
      .sort(),
    ['mainnet', 'regtest', 'signet', 'testnet']
  );
  assert.ok(capabilities
    .filter((capability) => capability.connectorId === 'nwc-nip47')
    .every((capability) => capability.assetId === 'bitcoin:btc' && capability.supportsLookup));
  assert.ok(capabilities.every((capability) => Array.isArray(capability.funding)));
  const fiberCapability = capabilities.find((capability) => capability.connectorId === 'fiber-rpc');
  assert.ok(fiberCapability);
  assert.equal(
    fiberCapability.funding.find((funding) => funding.mode === 'secured_autopay')?.requiresNetworkProof,
    true
  );
  const fundingSources = await request(app)
    .get('/v2/wallet/funding-sources')
    .set('Authorization', 'Bearer ' + token)
    .expect(200);
  assert.deepEqual(fundingSources.body, { sources: [] });
  await request(app).get('/v2/payment-connectors').expect(401);
  const expiredTicket = await createStreamTicket(authContext);
  assert.deepEqual(await getAuthContextFromStreamTicket(expiredTicket.ticket), authContext);
  await StreamTicketModel.updateOne(
    { tokenHash: createHash('sha256').update(expiredTicket.ticket).digest('hex') },
    { $set: { expiresAt: new Date(0) } }
  );
  await assert.rejects(
    () => getAuthContextFromStreamTicket(expiredTicket.ticket),
    (error: unknown) => (error as { code?: string }).code === 'STREAM_TICKET_INVALID'
  );
  await createStreamTicket(authContext);
  await revokeAuthToken(token);
  assert.equal(await StreamTicketModel.countDocuments({ walletId }), 0);
  await assert.rejects(
    () => getAuthContextFromToken(token),
    (error: unknown) => (error as { code?: string }).code === 'AUTH_SESSION_INVALID'
  );

  const rateApp = express();
  rateApp.use(createRateLimitMiddleware({
    windowMs: 60_000,
    max: 3,
    keyPrefix: 'platform-shared',
    store: 'mongo',
    keyGenerator: () => 'same-client'
  }));
  rateApp.get('/limited', (_request, response) => response.json({ ok: true }));
  rateApp.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const apiError = error as { statusCode?: number; code?: string };
    response.status(apiError.statusCode ?? 500).json({ error: { code: apiError.code ?? 'ERROR' } });
  });
  const rateResponses = await Promise.all(Array.from({ length: 6 }, () => request(rateApp).get('/limited')));
  assert.equal(rateResponses.filter((response) => response.status === 200).length, 3);
  assert.equal(rateResponses.filter((response) => response.status === 429).length, 3);

  await AppModel.create([
    {
      appId,
      ownerWalletId: walletId,
      name: 'Platform integration app',
      serviceAddress: walletAddress,
      status: 'active'
    },
    {
      appId: 'other-wallet-app',
      ownerWalletId: 'other-wallet',
      name: 'Other wallet app',
      serviceAddress: walletAddress,
      status: 'active'
    },
    {
      appId: 'inactive-owned-app',
      ownerWalletId: walletId,
      name: 'Inactive owned app',
      serviceAddress: walletAddress,
      status: 'revoked'
    }
  ]);
  const createPolicy = await getCreateSessionPolicy(walletId);
  assert.equal(createPolicy.contractVersion, '2.0');
  assert.equal(createPolicy.limits.assetId, 'ckb:ckb');
  assert.equal(createPolicy.limits.minAtomic, '1000000');
  assert.equal(createPolicy.limits.maxAtomic, '10000000000000');
  assert.equal(createPolicy.verifiedApps.length, 1);
  assert.deepEqual(createPolicy.verifiedApps[0], {
    id: appId,
    name: 'Platform integration app',
    serviceAddress: walletAddress,
    url: '',
    category: 'API',
    trustLevel: 'owner-approved',
    description: '',
    defaultCharge: 0.01,
    defaultChargeMinor: 1_000_000,
    chargePolicy: 'This owned app may create charges within the pass rule using an active app API key.',
    iconType: 'code',
    permissions: ['charges:create']
  });
  await SessionModel.create({
    ownerWalletId: walletId,
    publicId: sessionId,
    name: 'Platform automation pass',
    serviceAddress: walletAddress,
    appId,
    appPermissions: ['charges:create'],
    appGrantOwnerWalletId: walletId,
    appGrantCreatedAt: new Date(),
    paymentPurpose: 'app_session',
    spent: 0,
    spentMinor: 0,
    reservedMinor: 0,
    limit: 10,
    limitMinor: 1_000_000_000,
    currency: 'CKB',
    duration: 'integration',
    status: 'active',
    iconType: 'rpc',
    expiryTime: 'No expiry',
    autoMicroCharges: true,
    singleUse: false,
    lifecycleState: 'idle',
    logs: []
  });
  const unsupportedSessionId = 'platform-unsupported-rail-session';
  await SessionModel.create({
    ownerWalletId: walletId,
    publicId: unsupportedSessionId,
    name: 'Unsupported connector pass',
    serviceAddress: walletAddress,
    paymentPurpose: 'app_session',
    spent: 0,
    spentMinor: 0,
    reservedMinor: 0,
    limit: 10,
    limitMinor: 1_000_000_000,
    currency: 'BTC',
    duration: 'integration',
    status: 'active',
    iconType: 'rpc',
    expiryTime: 'No expiry',
    autoMicroCharges: true,
    singleUse: false,
    lifecycleState: 'idle',
    logs: []
  });
  await assert.rejects(
    () => chargeSession({
      sessionId: unsupportedSessionId,
      amount: 0.01,
      type: 'Unsupported connector charge',
      chargeOrigin: 'system',
      idempotencyKey: 'platform-unsupported-connector',
      paymentRequest: 'unsupported-payment-request-12345'
    }),
    (error: unknown) => (error as { code?: string }).code === 'PAYMENT_CAPABILITY_UNSUPPORTED'
  );
  assert.equal(await ChargeAttemptModel.countDocuments({ sessionId: unsupportedSessionId }), 0);
  const actor = { appId, ownerWalletId: walletId, source: 'wallet' as const };
  const recipient = await createRecipient(actor, {
    name: 'Platform recipient',
    serviceAddress: walletAddress,
    externalId: 'recipient-external-id'
  });
  const recipientIdentity = await RecipientIdentityModel.findOne({ recipientId: recipient.id }).lean();
  assert.equal(recipientIdentity?.automationRecipientId, recipient.id);
  const activeDestination = await PaymentDestinationModel.findOne({ recipientId: recipient.id, status: 'active' }).lean();
  assert.equal(activeDestination?.kind, 'address');
  assert.equal(activeDestination?.reusable, true);
  assert.equal(activeDestination?.verificationScope, 'delivery_instruction');
  const invoices = await Promise.allSettled(Array.from({ length: 20 }, () => createInvoice(actor, {
    sessionId,
    recipientId: recipient.id,
    amount: 0.1,
    idempotencyKey: 'platform-invoice-idempotency'
  })));
  assert.equal(invoices.filter((result) => result.status === 'fulfilled').length, 1);
  const createdInvoice = invoices.find((result) => result.status === 'fulfilled');
  assert.equal(createdInvoice?.status === 'fulfilled' ? createdInvoice.value.contractVersion : undefined, '2.0');
  assert.equal(createdInvoice?.status === 'fulfilled' ? createdInvoice.value.assetId : undefined, 'ckb:ckb');
  assert.equal(createdInvoice?.status === 'fulfilled' ? createdInvoice.value.amountAtomic : undefined, '10000000');
  assert.equal(await InvoiceModel.countDocuments({ appId, idempotencyKey: 'platform-invoice-idempotency' }), 1);

  await PaymentJobModel.create({
    jobId: 'platform-orphan-job',
    ownerWalletId: walletId,
    appId,
    sessionId,
    invoiceId: 'missing-invoice',
    recipientId: recipient.id,
    amount: 0.1,
    amountMinor: 10_000_000,
    currency: 'CKB',
    status: 'queued',
    runAfter: new Date(0),
    attempts: 0,
    maxAttempts: 3
  });
  await migrateLegacyMoneyToAtomicStrings();
  const migratedSession = await SessionModel.findOne({ publicId: sessionId }).lean();
  const migratedInvoice = await InvoiceModel.findOne({ appId, idempotencyKey: 'platform-invoice-idempotency' }).lean();
  const migratedJob = await PaymentJobModel.findOne({ jobId: 'platform-orphan-job' }).lean();
  assert.equal(migratedSession?.limitAtomic, '1000000000');
  assert.equal(migratedSession?.spentAtomic, '0');
  assert.equal(migratedInvoice?.amountAtomic, '10000000');
  assert.equal(migratedJob?.amountAtomic, '10000000');
  const workerRuns = await Promise.all(
    Array.from({ length: 20 }, (_, index) => runPaymentWorkerOnce({ workerId: 'platform-worker-' + index, limit: 1 }))
  );
  assert.equal(workerRuns.reduce((total, result) => total + result.processed, 0), 1);
  const orphanJob = await PaymentJobModel.findOne({ jobId: 'platform-orphan-job' }).lean();
  assert.equal(orphanJob?.attempts, 1);
  assert.equal(orphanJob?.lastFailureCode, 'INVOICE_NOT_FOUND');
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
