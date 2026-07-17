import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { networks, Psbt } from 'bitcoinjs-lib';
import request from 'supertest';
import { MockBitcoinCoreServer, MockBtcpayServer } from './bitcoinTestServers.js';

const uri = process.env.BITCOIN_TEST_MONGODB_URI;
if (!uri) throw new Error('BITCOIN_TEST_MONGODB_URI is required for Bitcoin integration tests.');

const btcpay = new MockBtcpayServer();
const core = new MockBitcoinCoreServer();
await Promise.all([btcpay.start(), core.start()]);

process.env.BTCPAY_SECRET_ENCRYPTION_KEY = '66'.repeat(32);
process.env.BTCPAY_ALLOW_INSECURE_LOCAL = 'true';
process.env.BTCPAY_REQUEST_TIMEOUT_MS = '1000';
process.env.BITCOIN_NETWORK = 'regtest';
process.env.BITCOIN_CORE_RPC_URL = core.rpcUrl;
process.env.BITCOIN_CORE_RPC_USER = core.rpcUsername;
process.env.BITCOIN_CORE_RPC_PASSWORD = core.rpcPassword;
process.env.BITCOIN_CORE_RPC_TIMEOUT_MS = '1000';
process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';

const dbName = 'fiberpass_bitcoin_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });
const { app } = await import('../app.js');
const { AuditLogModel } = await import('../models/auditLog.model.js');
const { AuthSessionModel } = await import('../models/auth.model.js');
const { BitcoinPsbtModel, BtcpayConnectionModel, BtcpayInvoiceModel, BtcpayPaymentModel } = await import('../models/bitcoin.model.js');
const { RateLimitBucketModel } = await import('../models/rateLimitBucket.model.js');

const ownerWalletId = 'bitcoin-owner';
const ownerAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const token = 'bitcoin-auth-token';
const authorization = 'Bearer ' + token;

function mutatedPsbt(base64: string): string {
  const source = Psbt.fromBase64(base64, { network: networks.regtest });
  const changed = new Psbt({ network: networks.regtest });
  changed.setVersion(2);
  source.txInputs.forEach((input, index) => {
    const witnessUtxo = source.data.inputs[index]?.witnessUtxo;
    if (!witnessUtxo) throw new Error('Fixture PSBT input is missing witness UTXO data.');
    changed.addInput({ hash: input.hash, index: input.index, sequence: input.sequence, witnessUtxo });
  });
  source.txOutputs.forEach((output, index) => {
    const delta = index === 0 ? -1n : 1n;
    changed.addOutput({ script: output.script, value: output.value + delta });
  });
  return changed.toBase64();
}

try {
  await Promise.all([
    AuditLogModel.syncIndexes(),
    AuthSessionModel.syncIndexes(),
    BtcpayConnectionModel.syncIndexes(),
    BtcpayInvoiceModel.syncIndexes(),
    BtcpayPaymentModel.syncIndexes(),
    BitcoinPsbtModel.syncIndexes(),
    RateLimitBucketModel.syncIndexes()
  ]);
  await AuthSessionModel.create({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    walletId: ownerWalletId,
    address: ownerAddress,
    expiresAt: new Date(Date.now() + 10 * 60_000)
  });

  const nonOrigin = await request(app)
    .post('/v2/wallet/btcpay-connections')
    .set('Authorization', authorization)
    .send({
      serverUrl: btcpay.origin + '?credential=must-not-be-accepted',
      storeId: btcpay.storeId,
      apiKey: btcpay.apiKey,
      network: 'regtest',
      scopeType: 'wallet'
    })
    .expect(400);
  assert.equal(nonOrigin.body.error.code, 'BTCPAY_URL_INVALID');

  const overprivileged = await request(app)
    .post('/v2/wallet/btcpay-connections')
    .set('Authorization', authorization)
    .send({
      serverUrl: btcpay.origin,
      storeId: btcpay.storeId,
      apiKey: btcpay.broadApiKey,
      network: 'regtest',
      scopeType: 'wallet'
    })
    .expect(409);
  assert.equal(overprivileged.body.error.code, 'BTCPAY_LEAST_PRIVILEGE_REQUIRED');

  const paired = await request(app)
    .post('/v2/wallet/btcpay-connections')
    .set('Authorization', authorization)
    .send({
      serverUrl: btcpay.origin,
      storeId: btcpay.storeId,
      apiKey: btcpay.apiKey,
      network: 'regtest',
      scopeType: 'wallet'
    })
    .expect(201);
  const connectionId = paired.body.id as string;
  assert.equal(paired.body.scope.id, ownerWalletId);
  assert.equal(paired.body.network, 'regtest');
  assert.equal(paired.body.permissions.length, 3);
  assert.ok(!JSON.stringify(paired.body).includes(btcpay.apiKey));

  const rawConnection = await BtcpayConnectionModel.collection.findOne({ connectionId });
  assert.ok(rawConnection?.apiKeyCiphertext);
  assert.ok(!JSON.stringify(rawConnection).includes(btcpay.apiKey));
  assert.equal((await BtcpayConnectionModel.findOne({ connectionId }).lean() as { apiKeyCiphertext?: string } | null)?.apiKeyCiphertext, undefined);

  const lightningReceive = await request(app)
    .post('/v2/wallet/btcpay-connections/' + connectionId + '/invoices')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'bitcoin-receive-lightning')
    .send({ rail: 'lightning', amountAtomic: '2500000' })
    .expect(201);
  assert.equal(lightningReceive.body.amountAtomic, '2500000');
  assert.ok(String(lightningReceive.body.paymentRequest).startsWith('lnbcrt'));

  const onchainReceive = await request(app)
    .post('/v2/wallet/btcpay-connections/' + connectionId + '/invoices')
    .set('Authorization', authorization)
    .send({ rail: 'bitcoin_onchain', amountAtomic: '3500000', idempotencyKey: 'bitcoin-receive-onchain' })
    .expect(201);
  assert.ok(String(onchainReceive.body.paymentRequest).startsWith('bitcoin:bcrt1'));
  assert.ok(String(onchainReceive.body.paymentRequest).includes('amount=0.000035'));

  btcpay.dropNextInvoiceResponse = true;
  await request(app)
    .post('/v2/wallet/btcpay-connections/' + connectionId + '/invoices')
    .set('Authorization', authorization)
    .send({ rail: 'lightning', amountAtomic: '4500000', idempotencyKey: 'bitcoin-receive-recovery' })
    .expect(503);
  const invoiceCallsAfterLostResponse = btcpay.invoiceCreateCalls;
  const recoveredReceive = await request(app)
    .post('/v2/wallet/btcpay-connections/' + connectionId + '/invoices')
    .set('Authorization', authorization)
    .send({ rail: 'lightning', amountAtomic: '4500000', idempotencyKey: 'bitcoin-receive-recovery' })
    .expect(201);
  assert.equal(recoveredReceive.body.amountAtomic, '4500000');
  assert.equal(btcpay.invoiceCreateCalls, invoiceCallsAfterLostResponse);
  assert.ok(btcpay.invoiceLookupCalls > 0);

  const invoiceRecords = await BtcpayInvoiceModel.collection.find({ connectionId }).toArray();
  assert.ok(invoiceRecords.every((record) => record.paymentRequest === undefined && record.BOLT11 === undefined));

  const outgoing = btcpay.createOutgoingInvoice({ amountAtomic: '1500500', preimage: '77'.repeat(32) });
  const paid = await request(app)
    .post('/v2/wallet/btcpay-connections/' + connectionId + '/lightning-payments')
    .set('Authorization', authorization)
    .send({ invoice: outgoing.invoice, maxFeeAtomic: '5000', idempotencyKey: 'bitcoin-micropayment-success' })
    .expect(200);
  assert.equal(paid.body.status, 'succeeded');
  assert.equal(paid.body.amountAtomic, '1500500');
  assert.equal(paid.body.feeAtomic, '1000');
  assert.equal(paid.body.proof.reference, outgoing.paymentHash);
  assert.ok(!JSON.stringify(paid.body).includes('77'.repeat(32)));
  const payCallsAfterSuccess = btcpay.lightningPayCalls;
  const paymentReplay = await request(app)
    .post('/v2/wallet/btcpay-connections/' + connectionId + '/lightning-payments')
    .set('Authorization', authorization)
    .send({ invoice: outgoing.invoice, maxFeeAtomic: '5000', idempotencyKey: 'bitcoin-micropayment-success' })
    .expect(200);
  assert.equal(paymentReplay.body.id, paid.body.id);
  assert.equal(btcpay.lightningPayCalls, payCallsAfterSuccess);

  const uncertainOutgoing = btcpay.createOutgoingInvoice({ amountAtomic: '2100000', preimage: '88'.repeat(32) });
  btcpay.dropNextPaymentResponse = true;
  const uncertain = await request(app)
    .post('/v2/wallet/btcpay-connections/' + connectionId + '/lightning-payments')
    .set('Authorization', authorization)
    .send({ invoice: uncertainOutgoing.invoice, maxFeeAtomic: '5000', idempotencyKey: 'bitcoin-micropayment-recovery' })
    .expect(202);
  assert.equal(uncertain.body.status, 'uncertain');
  const payCallsAfterUncertain = btcpay.lightningPayCalls;
  const reconciledPayment = await request(app)
    .get('/v2/wallet/btcpay-connections/' + connectionId + '/lightning-payments/' + uncertainOutgoing.paymentHash)
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(reconciledPayment.body.status, 'succeeded');
  assert.equal(reconciledPayment.body.failure, undefined);
  assert.equal(btcpay.lightningPayCalls, payCallsAfterUncertain);
  assert.ok(btcpay.paymentLookupCalls > 0);

  const rawPayment = await BtcpayPaymentModel.collection.findOne({ paymentHash: outgoing.paymentHash });
  assert.equal(rawPayment?.invoice, undefined);
  assert.equal(rawPayment?.preimage, undefined);

  const createPsbtBody = {
    network: 'regtest',
    scopeType: 'wallet',
    destination: 'bitcoin:' + core.recipientAddress + '?amount=0.00005000',
    amountAtomic: '5000000',
    inputs: [{ txid: core.fundingTxid, vout: core.fundingVout }],
    changeAddress: core.changeAddress,
    feeRateSatVb: '2',
    maxFeeAtomic: '1000000',
    minInputConfirmations: 1,
    requiredConfirmations: 2,
    idempotencyKey: 'bitcoin-psbt-primary'
  };
  const createdPsbt = await request(app)
    .post('/v2/wallet/bitcoin/psbts')
    .set('Authorization', authorization)
    .send(createPsbtBody)
    .expect(201);
  assert.equal(createdPsbt.body.status, 'awaiting_signature');
  assert.equal(createdPsbt.body.recipient.amountAtomic, '5000000');
  assert.ok(BigInt(createdPsbt.body.fee.amountAtomic) <= 1000000n);
  const decodedPsbt = Psbt.fromBase64(createdPsbt.body.psbt, { network: networks.regtest });
  assert.equal(decodedPsbt.txOutputs[0].value, 5000n);
  assert.equal(decodedPsbt.txOutputs.reduce((sum, output) => sum + output.value, 0n) + BigInt(createdPsbt.body.fee.amountAtomic) / 1000n, 10000n);

  const reusedOutpoint = await request(app)
    .post('/v2/wallet/bitcoin/psbts')
    .set('Authorization', authorization)
    .send({ ...createPsbtBody, idempotencyKey: 'bitcoin-psbt-conflicting-outpoint' })
    .expect(409);
  assert.equal(reusedOutpoint.body.error.code, 'BITCOIN_INPUT_ALREADY_IN_USE');

  const mutated = await request(app)
    .post('/v2/wallet/bitcoin/psbts/' + createdPsbt.body.id + '/submit')
    .set('Authorization', authorization)
    .send({ signedPsbt: mutatedPsbt(createdPsbt.body.psbt) })
    .expect(409);
  assert.equal(mutated.body.error.code, 'BITCOIN_PSBT_OUTPUT_MUTATED');
  assert.equal(core.sendCalls, 0);

  core.rejectNextSend = true;
  const uncertainBroadcast = await request(app)
    .post('/v2/wallet/bitcoin/psbts/' + createdPsbt.body.id + '/submit')
    .set('Authorization', authorization)
    .send({ signedPsbt: createdPsbt.body.psbt })
    .expect(202);
  assert.equal(uncertainBroadcast.body.status, 'broadcast');
  assert.equal(uncertainBroadcast.body.failure.code, 'BITCOIN_BROADCAST_OUTCOME_UNKNOWN');
  assert.equal(core.sendCalls, 0);
  assert.equal(core.sendAttempts, 1);
  await BitcoinPsbtModel.updateOne(
    { psbtId: createdPsbt.body.id },
    { $set: { broadcastAt: new Date(Date.now() - 10_000) } }
  );

  const broadcast = await request(app)
    .get('/v2/wallet/bitcoin/psbts/' + createdPsbt.body.id)
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(broadcast.body.status, 'broadcast');
  assert.equal(broadcast.body.failure, undefined);
  assert.match(broadcast.body.txid, /^[0-9a-f]{64}$/);
  assert.equal(core.sendCalls, 1);
  assert.equal(core.sendAttempts, 2);

  const txOutCallsBeforeReplay = core.rpcMethods.filter((method) => method === 'gettxout').length;
  const replayAfterSpend = await request(app)
    .post('/v2/wallet/bitcoin/psbts')
    .set('Authorization', authorization)
    .send(createPsbtBody)
    .expect(201);
  assert.equal(replayAfterSpend.body.id, createdPsbt.body.id);
  assert.equal(replayAfterSpend.body.status, 'broadcast');
  assert.equal(core.rpcMethods.filter((method) => method === 'gettxout').length, txOutCallsBeforeReplay);

  const replacement = await request(app)
    .post('/v2/wallet/bitcoin/psbts')
    .set('Authorization', authorization)
    .send({
      ...createPsbtBody,
      inputs: [],
      feeRateSatVb: '4',
      idempotencyKey: 'bitcoin-psbt-replacement',
      replacesPsbtId: createdPsbt.body.id
    })
    .expect(201);
  assert.equal(replacement.body.replacesPsbtId, createdPsbt.body.id);
  assert.ok(BigInt(replacement.body.fee.amountAtomic) > BigInt(createdPsbt.body.fee.amountAtomic));
  const replacementBroadcast = await request(app)
    .post('/v2/wallet/bitcoin/psbts/' + replacement.body.id + '/submit')
    .set('Authorization', authorization)
    .send({ signedPsbt: replacement.body.psbt })
    .expect(202);
  assert.equal(replacementBroadcast.body.status, 'broadcast');
  assert.notEqual(replacementBroadcast.body.txid, broadcast.body.txid);
  assert.equal(core.sendCalls, 2);

  const replacedOriginal = await request(app)
    .get('/v2/wallet/bitcoin/psbts/' + createdPsbt.body.id)
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(replacedOriginal.body.status, 'replaced');
  assert.equal(replacedOriginal.body.replacedByPsbtId, replacement.body.id);

  core.confirmations = 2;
  const confirmed = await request(app)
    .get('/v2/wallet/bitcoin/psbts/' + replacement.body.id)
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(confirmed.body.status, 'confirmed');
  assert.equal(confirmed.body.confirmations, 2);

  const rawPsbt = await BitcoinPsbtModel.collection.findOne({ psbtId: replacement.body.id });
  assert.ok(rawPsbt?.rawTransactionHex);
  assert.equal((await BitcoinPsbtModel.findOne({ psbtId: replacement.body.id }).lean() as { rawTransactionHex?: string } | null)?.rawTransactionHex, undefined);
  assert.ok(core.rpcMethods.every((method) => !method.includes('sign') && !method.includes('walletpassphrase')));

  const disconnected = await request(app)
    .delete('/v2/wallet/btcpay-connections/' + connectionId)
    .set('Authorization', authorization)
    .send({ reason: 'Integration test complete' })
    .expect(200);
  assert.equal(disconnected.body.remoteRevoked, true);
  assert.ok(btcpay.revokedKeys.has(btcpay.apiKey));
  const revokedRaw = await BtcpayConnectionModel.collection.findOne({ connectionId });
  assert.equal(revokedRaw?.apiKeyCiphertext, undefined);
  assert.equal(revokedRaw?.serverOrigin, '');
  assert.equal(revokedRaw?.storeId, '');
} finally {
  await Promise.all([btcpay.close(), core.close()]);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
