import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuthSessionModel } from '../models/auth.model.js';
import { RecipientModel } from '../models/automation.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import {
  ClaimChannelModel,
  NotificationEndpointModel,
  PaymentDestinationModel,
  RecipientClaimModel,
  RecipientIdentityModel,
  WalletPrincipalModel
} from '../models/identity.model.js';
import { RateLimitBucketModel } from '../models/rateLimitBucket.model.js';
import { SessionModel } from '../models/session.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { migrateRecipientIdentitySeparation } from '../migrations/identitySeparation.js';

const uri = process.env.IDENTITY_TEST_MONGODB_URI;
if (!uri) throw new Error('IDENTITY_TEST_MONGODB_URI is required for recipient identity integration tests.');

process.env.FIBER_NETWORK = 'testnet';
process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';

const dbName = 'fiberpass_identity_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });
const { app } = await import('../app.js');

const walletAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const ownerWalletId = 'identity-owner';
const authToken = 'identity-auth-token';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function createClaimCase(input: {
  suffix: string;
  token: string;
  paymentPurpose?: 'scheduled_release' | 'recurring_release';
  expiresAt?: Date;
}): Promise<{ sessionId: string; claimId: string; recipientId: string }> {
  const sessionId = 'identity-session-' + input.suffix;
  const recipientId = 'identity-recipient-' + input.suffix;
  const claimId = 'identity-claim-' + input.suffix;
  const channelId = 'identity-channel-' + input.suffix;
  const endpointId = 'identity-notification-' + input.suffix;
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 60_000);
  await RecipientIdentityModel.create({
    recipientId,
    ownerWalletId,
    name: 'Recipient ' + input.suffix,
    sessionId,
    sessionRecipientIndex: 0
  });
  await ClaimChannelModel.create({
    channelId,
    recipientId,
    ownerWalletId,
    type: 'email',
    value: input.suffix + '@example.com',
    valueHash: tokenHash(input.suffix + '@example.com'),
    status: 'active'
  });
  await NotificationEndpointModel.create({
    endpointId,
    recipientId,
    ownerWalletId,
    type: 'email',
    purpose: 'receipt',
    value: input.suffix + '@example.com',
    valueHash: tokenHash(input.suffix + '@example.com'),
    status: 'active'
  });
  await RecipientClaimModel.create({
    claimId,
    recipientId,
    ownerWalletId,
    sessionId,
    sessionRecipientIndex: 0,
    channelId,
    tokenHash: tokenHash(input.token),
    purpose: 'bind_destination',
    status: 'pending',
    expiresAt
  });
  await SessionModel.create({
    ownerWalletId,
    publicId: sessionId,
    name: 'Identity pass ' + input.suffix,
    serviceAddress: walletAddress,
    paymentPurpose: input.paymentPurpose ?? 'scheduled_release',
    recipientWallets: [{
      recipientId,
      claimId,
      claimChannelId: channelId,
      notificationEndpointId: endpointId,
      name: 'Recipient ' + input.suffix,
      email: input.suffix + '@example.com',
      amount: 100,
      amountMinor: 10_000_000_000,
      status: 'awaiting_details',
      inviteStatus: 'sent',
      inviteTokenHash: tokenHash(input.token),
      inviteTokenExpiresAt: expiresAt
    }],
    releaseCadence: input.paymentPurpose === 'recurring_release' ? 'monthly' : 'none',
    spent: 0,
    spentMinor: 0,
    reservedMinor: 0,
    limit: 100,
    limitMinor: 10_000_000_000,
    currency: 'CKB',
    duration: 'identity integration',
    status: 'active',
    iconType: 'rpc',
    expiryTime: 'No expiry',
    lifecycleState: 'idle',
    autoMicroCharges: true,
    singleUse: false,
    logs: []
  });
  return { sessionId, claimId, recipientId };
}

try {
  await Promise.all([
    AuthSessionModel.syncIndexes(),
    ChargeAttemptModel.syncIndexes(),
    ClaimChannelModel.syncIndexes(),
    NotificationEndpointModel.syncIndexes(),
    PaymentDestinationModel.syncIndexes(),
    RecipientClaimModel.syncIndexes(),
    RecipientIdentityModel.syncIndexes(),
    WalletPrincipalModel.syncIndexes(),
    RateLimitBucketModel.syncIndexes(),
    RecipientModel.syncIndexes(),
    SessionModel.syncIndexes(),
    WalletModel.syncIndexes()
  ]);
  await WalletModel.create({
    walletId: 'legacy-identity-owner',
    connected: true,
    address: walletAddress,
    balance: 100,
    balanceMinor: 10_000_000_000,
    currency: 'CKB'
  });
  await SessionModel.create({
    ownerWalletId: 'legacy-identity-owner',
    publicId: 'legacy-identity-session',
    name: 'Legacy identity pass',
    serviceAddress: walletAddress,
    paymentPurpose: 'scheduled_release',
    recipientWallets: [{
      name: 'Legacy email recipient',
      email: 'legacy@example.com',
      address: walletAddress,
      amount: 100,
      amountMinor: 10_000_000_000,
      inviteStatus: 'sent',
      inviteTokenHash: tokenHash('legacy-claim-token'),
      inviteTokenExpiresAt: new Date(Date.now() + 60_000)
    }],
    releaseCadence: 'none',
    spent: 0,
    spentMinor: 0,
    reservedMinor: 0,
    limit: 100,
    limitMinor: 10_000_000_000,
    currency: 'CKB',
    duration: 'legacy migration',
    status: 'active',
    iconType: 'rpc',
    expiryTime: 'No expiry',
    lifecycleState: 'idle',
    autoMicroCharges: true,
    singleUse: false,
    logs: []
  });
  await RecipientModel.create({
    recipientId: 'legacy-automation-recipient',
    ownerWalletId: 'legacy-identity-owner',
    appId: 'legacy-app',
    name: 'Legacy automation recipient',
    serviceAddress: walletAddress,
    invoiceEndpoint: 'https://recipient.example/fiber-invoice',
    status: 'active'
  });
  await migrateRecipientIdentitySeparation();
  await migrateRecipientIdentitySeparation();
  assert.equal(await WalletPrincipalModel.countDocuments({ walletId: 'legacy-identity-owner' }), 1);
  assert.equal(await RecipientIdentityModel.countDocuments({ ownerWalletId: 'legacy-identity-owner' }), 2);
  assert.equal(await PaymentDestinationModel.countDocuments({ ownerWalletId: 'legacy-identity-owner' }), 2);
  assert.equal((await PaymentDestinationModel.findOne({ recipientId: 'legacy-automation-recipient' }).lean())?.kind, 'endpoint');
  assert.equal(await RecipientClaimModel.countDocuments({ ownerWalletId: 'legacy-identity-owner' }), 1);

  await AuthSessionModel.create({
    tokenHash: tokenHash(authToken),
    walletId: ownerWalletId,
    address: walletAddress,
    expiresAt: new Date(Date.now() + 60_000)
  });

  const raceToken = 'race-token-' + 'a'.repeat(40);
  const race = await createClaimCase({ suffix: 'race', token: raceToken });
  const raceResponses = await Promise.all(Array.from({ length: 10 }, () => request(app)
    .post('/v2/recipient-claims/' + raceToken)
    .send({ address: walletAddress, timeZone: 'Africa/Nairobi' })));
  assert.equal(raceResponses.filter((response) => response.status === 200).length, 1);
  assert.equal(raceResponses.filter((response) => response.status === 409 && response.body.error?.code === 'RECIPIENT_CLAIM_ALREADY_USED').length, 9);
  assert.equal(await PaymentDestinationModel.countDocuments({ recipientId: race.recipientId, status: 'active' }), 1);
  assert.equal((await RecipientClaimModel.findOne({ claimId: race.claimId }).lean())?.status, 'claimed');
  assert.ok((await ClaimChannelModel.findOne({ recipientId: race.recipientId }).lean())?.deliveryVerifiedAt);
  assert.equal((await SessionModel.findOne({ publicId: race.sessionId }).lean())?.recipientWallets[0]?.address, walletAddress);

  const reused = await request(app)
    .post('/v2/recipient-claims/' + raceToken)
    .send({ address: walletAddress })
    .expect(409);
  assert.equal(reused.body.error.code, 'RECIPIENT_CLAIM_ALREADY_USED');

  const expiredToken = 'expired-token-' + 'b'.repeat(40);
  await createClaimCase({ suffix: 'expired', token: expiredToken, expiresAt: new Date(Date.now() - 1000) });
  const expired = await request(app)
    .post('/v2/recipient-claims/' + expiredToken)
    .send({ address: walletAddress })
    .expect(410);
  assert.equal(expired.body.error.code, 'RECIPIENT_CLAIM_EXPIRED');

  const revokedToken = 'revoked-token-' + 'c'.repeat(40);
  const revokedCase = await createClaimCase({ suffix: 'revoked', token: revokedToken });
  await request(app)
    .post('/v2/sessions/' + revokedCase.sessionId + '/recipient-claims/' + revokedCase.claimId + '/revoke')
    .set('Authorization', 'Bearer ' + authToken)
    .expect(200);
  const revoked = await request(app)
    .post('/v2/recipient-claims/' + revokedToken)
    .send({ address: walletAddress })
    .expect(410);
  assert.equal(revoked.body.error.code, 'RECIPIENT_CLAIM_REVOKED');

  const recurringToken = 'recurring-token-' + 'd'.repeat(40);
  await createClaimCase({ suffix: 'recurring', token: recurringToken, paymentPurpose: 'recurring_release' });
  const recurring = await request(app)
    .post('/v2/recipient-claims/' + recurringToken)
    .send({ fiberInvoice: 'fiber-one-time-payment-request' })
    .expect(400);
  assert.equal(recurring.body.error.code, 'RECIPIENT_REUSABLE_DESTINATION_REQUIRED');

  await ChargeAttemptModel.create({
    attemptId: 'identity-proof',
    sessionId: race.sessionId,
    ownerWalletId,
    amount: 100,
    amountMinor: 10_000_000_000,
    currency: 'CKB',
    type: 'Recipient payout',
    status: 'succeeded',
    reserveStatus: 'debited',
    providerStatus: 'succeeded',
    proofId: '0ximmutable-proof',
    proofType: 'ckb_transaction',
    executionLayer: 'fiber'
  });
  await request(app).get('/v2/privacy/export').expect(401);
  const beforeDeletion = await request(app)
    .get('/v2/privacy/export')
    .set('Authorization', 'Bearer ' + authToken)
    .expect(200);
  assert.ok(beforeDeletion.body.recipients.some((recipient: { claimChannels: Array<{ value?: string }> }) => recipient.claimChannels.some((channel) => channel.value)));
  assert.equal(beforeDeletion.body.immutablePaymentProofs.length, 1);

  const deletion = await request(app)
    .delete('/v2/privacy/contact-data')
    .set('Authorization', 'Bearer ' + authToken)
    .expect(200);
  assert.equal(deletion.body.paymentProofsPreserved, 1);
  assert.equal(await ChargeAttemptModel.countDocuments({ attemptId: 'identity-proof', proofId: '0ximmutable-proof' }), 1);
  assert.equal(await ClaimChannelModel.countDocuments({ ownerWalletId, value: { $exists: true } }), 0);
  assert.equal(await NotificationEndpointModel.countDocuments({ ownerWalletId, value: { $exists: true } }), 0);
  assert.equal(await SessionModel.countDocuments({ ownerWalletId, 'recipientWallets.email': { $exists: true } }), 0);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
