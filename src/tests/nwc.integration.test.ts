import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { generateSecretKey } from 'nostr-tools/pure';
import request from 'supertest';
import { AppModel } from '../models/app.model.js';
import { AuditLogModel } from '../models/auditLog.model.js';
import { AuthSessionModel } from '../models/auth.model.js';
import { NwcConnectionModel, NwcPaymentModel } from '../models/nwc.model.js';
import { RateLimitBucketModel } from '../models/rateLimitBucket.model.js';
import { MockNwcRelayWallet } from './nwcTestWallet.js';

const uri = process.env.NWC_TEST_MONGODB_URI;
if (!uri) throw new Error('NWC_TEST_MONGODB_URI is required for NWC integration tests.');

process.env.NWC_SECRET_ENCRYPTION_KEY = '55'.repeat(32);
process.env.NWC_ALLOW_INSECURE_LOCAL_RELAY = 'true';
process.env.NWC_REQUEST_TIMEOUT_MS = '1000';
process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';

const dbName = 'fiberpass_nwc_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });
const { app } = await import('../app.js');

const wallet = new MockNwcRelayWallet({ balance: '987654321' });
await wallet.start();
const signetWallet = new MockNwcRelayWallet({ network: 'signet', balance: '5000000' });
await signetWallet.start();
const ownerWalletId = 'nwc-owner';
const walletAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const token = 'nwc-auth-token';
const authorization = 'Bearer ' + token;

try {
  await Promise.all([
    AppModel.syncIndexes(),
    AuditLogModel.syncIndexes(),
    AuthSessionModel.syncIndexes(),
    NwcConnectionModel.syncIndexes(),
    NwcPaymentModel.syncIndexes(),
    RateLimitBucketModel.syncIndexes()
  ]);
  await AuthSessionModel.create({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    walletId: ownerWalletId,
    address: walletAddress,
    expiresAt: new Date(Date.now() + 60_000)
  });
  await AppModel.create([
    { appId: 'nwc-app-one', ownerWalletId, name: 'NWC App One', serviceAddress: walletAddress, status: 'active' },
    { appId: 'nwc-app-two', ownerWalletId, name: 'NWC App Two', serviceAddress: walletAddress, status: 'active' }
  ]);

  const firstSecret = generateSecretKey();
  const firstUri = wallet.connectionUri(firstSecret);
  const firstPair = await request(app)
    .post('/v2/wallet/nwc-connections')
    .set('Authorization', authorization)
    .send({
      connectionUri: firstUri,
      network: 'regtest',
      scopeType: 'app',
      scopeId: 'nwc-app-one',
      executionMode: 'interactive'
    })
    .expect(201);
  const firstConnectionId = firstPair.body.id as string;
  assert.equal(firstPair.body.encryption, 'nip44_v2');
  assert.equal(firstPair.body.execution.unattendedEligible, false);
  assert.ok(firstPair.body.methods.includes('pay_invoice'));
  assert.ok(!JSON.stringify(firstPair.body).includes(Buffer.from(firstSecret).toString('hex')));
  assert.ok(!JSON.stringify(firstPair.body).includes(firstUri));

  const reused = await request(app)
    .post('/v2/wallet/nwc-connections')
    .set('Authorization', authorization)
    .send({
      connectionUri: firstUri,
      network: 'regtest',
      scopeType: 'app',
      scopeId: 'nwc-app-one',
      executionMode: 'interactive'
    })
    .expect(409);
  assert.equal(reused.body.error.code, 'NWC_CONNECTION_KEY_REUSED');
  assert.ok(!JSON.stringify(reused.body).includes(Buffer.from(firstSecret).toString('hex')));

  const secondSecret = generateSecretKey();
  const secondPair = await request(app)
    .post('/wallet/nwc-connections')
    .set('Authorization', authorization)
    .send({
      connectionUri: wallet.connectionUri(secondSecret),
      network: 'regtest',
      scopeType: 'app',
      scopeId: 'nwc-app-two',
      executionMode: 'interactive'
    })
    .expect(201);
  const secondConnectionId = secondPair.body.id as string;
  assert.notEqual(firstConnectionId, secondConnectionId);

  const listed = await request(app).get('/v2/wallet/nwc-connections').set('Authorization', authorization).expect(200);
  assert.equal(listed.body.connections.length, 2);
  const balance = await request(app)
    .post('/v2/wallet/nwc-connections/' + firstConnectionId + '/balance/sync')
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(balance.body.balance.amountAtomic, '987654321');
  assert.equal(balance.body.balance.guarantee, 'balance_observed');

  const firstInvoice = wallet.createInvoice({ preimage: '66'.repeat(32), amount: '2500000' });
  const paid = await request(app)
    .post('/v2/wallet/nwc-connections/' + firstConnectionId + '/payments')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'nwc-payment-success')
    .send({ invoice: firstInvoice.invoice })
    .expect(200);
  assert.equal(paid.body.status, 'succeeded');
  assert.equal(paid.body.amountAtomic, '2500000');
  assert.equal(paid.body.proof.reference, firstInvoice.paymentHash);
  assert.equal(paid.body.proof.preimageVerified, true);
  assert.ok(!JSON.stringify(paid.body).includes('66'.repeat(32)));
  assert.equal(wallet.payInvoiceCalls, 1);

  const replayed = await request(app)
    .post('/wallet/nwc-connections/' + firstConnectionId + '/payments')
    .set('Authorization', authorization)
    .send({ invoice: firstInvoice.invoice, idempotencyKey: 'nwc-payment-success' })
    .expect(200);
  assert.equal(replayed.body.id, paid.body.id);
  assert.equal(wallet.payInvoiceCalls, 1);

  const concurrentReplays = await Promise.all(Array.from({ length: 4 }, () => request(app)
    .post('/v2/wallet/nwc-connections/' + firstConnectionId + '/payments')
    .set('Authorization', authorization)
    .send({ invoice: firstInvoice.invoice, idempotencyKey: 'nwc-payment-success' })));
  assert.ok(concurrentReplays.every((response) => response.status === 200 && response.body.id === paid.body.id));
  assert.equal(wallet.payInvoiceCalls, 1);

  const inFlightInvoice = wallet.createInvoice({ preimage: '88'.repeat(32), amount: '2750000' });
  const payCallsBeforeInFlight = wallet.payInvoiceCalls;
  const lookupCallsBeforeInFlight = wallet.lookupInvoiceCalls;
  wallet.payResponseDelayMs = 250;
  const firstInFlight = request(app)
    .post('/v2/wallet/nwc-connections/' + firstConnectionId + '/payments')
    .set('Authorization', authorization)
    .send({ invoice: inFlightInvoice.invoice, idempotencyKey: 'nwc-payment-in-flight' })
    .then((response) => response);
  for (let attempt = 0; attempt < 50 && wallet.payInvoiceCalls === payCallsBeforeInFlight; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(wallet.payInvoiceCalls, payCallsBeforeInFlight + 1);
  const duplicateInFlight = await request(app)
    .post('/v2/wallet/nwc-connections/' + firstConnectionId + '/payments')
    .set('Authorization', authorization)
    .send({ invoice: inFlightInvoice.invoice, idempotencyKey: 'nwc-payment-in-flight' })
    .expect(202);
  assert.equal(duplicateInFlight.body.status, 'pending');
  assert.equal(wallet.lookupInvoiceCalls, lookupCallsBeforeInFlight);
  const completedInFlight = await firstInFlight;
  wallet.payResponseDelayMs = 0;
  assert.equal(completedInFlight.status, 200);
  assert.equal(completedInFlight.body.status, 'succeeded');
  assert.equal(wallet.payInvoiceCalls, payCallsBeforeInFlight + 1);

  const uncertainInvoice = wallet.createInvoice({ preimage: '77'.repeat(32), amount: '3000000' });
  wallet.timeoutNextPay = true;
  const uncertain = await request(app)
    .post('/v2/wallet/nwc-connections/' + firstConnectionId + '/payments')
    .set('Authorization', authorization)
    .send({ invoice: uncertainInvoice.invoice, idempotencyKey: 'nwc-payment-timeout' })
    .expect(202);
  assert.equal(uncertain.body.status, 'uncertain');
  const payCallsAfterTimeout = wallet.payInvoiceCalls;

  const reconciled = await request(app)
    .get('/v2/wallet/nwc-connections/' + firstConnectionId + '/payments/' + uncertainInvoice.paymentHash)
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(reconciled.body.status, 'succeeded');
  assert.equal(reconciled.body.proof.reference, uncertainInvoice.paymentHash);
  assert.equal(wallet.payInvoiceCalls, payCallsAfterTimeout);
  assert.ok(wallet.lookupInvoiceCalls >= 1);

  const storedConnection = await NwcConnectionModel.collection.findOne({ connectionId: firstConnectionId });
  assert.ok(storedConnection?.secretCiphertext);
  assert.ok(!JSON.stringify(storedConnection).includes(Buffer.from(firstSecret).toString('hex')));
  assert.equal((await NwcConnectionModel.findOne({ connectionId: firstConnectionId }).lean() as { secretCiphertext?: string } | null)?.secretCiphertext, undefined);
  const storedPayment = await NwcPaymentModel.collection.findOne({ paymentHash: firstInvoice.paymentHash });
  assert.equal(storedPayment?.invoice, undefined);
  assert.equal(storedPayment?.preimage, undefined);

  const signetSecret = generateSecretKey();
  const signetPair = await request(app)
    .post('/v2/wallet/nwc-connections')
    .set('Authorization', authorization)
    .send({
      connectionUri: signetWallet.connectionUri(signetSecret),
      network: 'signet',
      scopeType: 'app',
      scopeId: 'nwc-app-two',
      executionMode: 'interactive'
    })
    .expect(201);
  assert.equal(signetPair.body.network, 'signet');
  const signetInvoice = signetWallet.createInvoice({ preimage: '99'.repeat(32), amount: '1500000' });
  assert.ok(signetInvoice.invoice.startsWith('lntbs'));
  const signetPaid = await request(app)
    .post('/v2/wallet/nwc-connections/' + signetPair.body.id + '/payments')
    .set('Authorization', authorization)
    .send({ invoice: signetInvoice.invoice, idempotencyKey: 'nwc-signet-payment' })
    .expect(200);
  assert.equal(signetPaid.body.network, 'signet');
  assert.equal(signetPaid.body.proof.reference, signetInvoice.paymentHash);
  assert.equal(signetWallet.payInvoiceCalls, 1);

  const unattendedSecret = generateSecretKey();
  const unattendedUri = wallet.connectionUri(unattendedSecret);
  await request(app)
    .post('/v2/wallet/nwc-connections')
    .set('Authorization', authorization)
    .send({ connectionUri: unattendedUri, network: 'regtest', scopeType: 'wallet', executionMode: 'unattended' })
    .expect(409);
  wallet.budget = { total: '10000000', used: '1000000', enforced: true, resetsAt: Math.floor(Date.now() / 1000) + 3600 };
  const unattended = await request(app)
    .post('/v2/wallet/nwc-connections')
    .set('Authorization', authorization)
    .send({ connectionUri: unattendedUri, network: 'regtest', scopeType: 'wallet', executionMode: 'unattended' })
    .expect(201);
  assert.equal(unattended.body.execution.unattendedEligible, true);
  assert.equal(unattended.body.execution.allowance.remainingAtomic, '9000000');

  await request(app)
    .delete('/v2/wallet/nwc-connections/' + firstConnectionId)
    .set('Authorization', authorization)
    .send({ reason: 'App one disconnected' })
    .expect(204);
  await request(app)
    .post('/v2/wallet/nwc-connections/' + firstConnectionId + '/balance/sync')
    .set('Authorization', authorization)
    .expect(404);
  await request(app)
    .post('/v2/wallet/nwc-connections/' + secondConnectionId + '/balance/sync')
    .set('Authorization', authorization)
    .expect(200);
  const revokedRaw = await NwcConnectionModel.collection.findOne({ connectionId: firstConnectionId });
  assert.equal(revokedRaw?.status, 'revoked');
  assert.equal(revokedRaw?.secretCiphertext, undefined);
  assert.deepEqual(revokedRaw?.relayUrls, []);
} finally {
  await signetWallet.close();
  await wallet.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
