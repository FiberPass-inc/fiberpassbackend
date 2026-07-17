import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';

const mongoUri = process.env.BITCOIN_CORE_REGTEST_TEST_MONGODB_URI;
const rpcUrl = process.env.BITCOIN_CORE_REGTEST_RPC_URL;
const rpcUsername = process.env.BITCOIN_CORE_REGTEST_RPC_USER;
const rpcPassword = process.env.BITCOIN_CORE_REGTEST_RPC_PASSWORD;
if (!mongoUri || !rpcUrl || !rpcUsername || !rpcPassword) {
  throw new Error('Bitcoin Core regtest Mongo and RPC environment variables are required.');
}

async function rpc<T>(method: string, params: unknown[] = [], walletName?: string): Promise<T> {
  const id = randomUUID();
  const endpoint = new URL(walletName ? '/wallet/' + encodeURIComponent(walletName) : '/', rpcUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(rpcUsername + ':' + rpcPassword).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const body = await response.json() as { id: string; result: T; error: { code: number; message: string } | null };
  if (body.id !== id || body.error) throw new Error('Bitcoin Core test RPC failed: ' + (body.error?.code ?? response.status));
  return body.result;
}

process.env.BITCOIN_NETWORK = 'regtest';
process.env.BITCOIN_CORE_RPC_URL = rpcUrl;
process.env.BITCOIN_CORE_RPC_USER = rpcUsername;
process.env.BITCOIN_CORE_RPC_PASSWORD = rpcPassword;
process.env.BITCOIN_CORE_RPC_TIMEOUT_MS = '5000';
process.env.BTCPAY_SECRET_ENCRYPTION_KEY = '99'.repeat(32);
process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';

const dbName = 'fiberpass_core_regtest_' + randomUUID().replace(/-/g, '');
await mongoose.connect(mongoUri, { dbName, serverSelectionTimeoutMS: 10_000 });
const { app } = await import('../app.js');
const { AuditLogModel } = await import('../models/auditLog.model.js');
const { AuthSessionModel } = await import('../models/auth.model.js');
const { BitcoinPsbtModel } = await import('../models/bitcoin.model.js');
const { RateLimitBucketModel } = await import('../models/rateLimitBucket.model.js');

const walletName = 'fiberpass-external-' + randomUUID();
const token = 'bitcoin-core-regtest-auth-token';
const authorization = 'Bearer ' + token;

try {
  await Promise.all([
    AuditLogModel.syncIndexes(),
    AuthSessionModel.syncIndexes(),
    BitcoinPsbtModel.syncIndexes(),
    RateLimitBucketModel.syncIndexes()
  ]);
  await AuthSessionModel.create({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    walletId: 'bitcoin-core-regtest-owner',
    address: 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl',
    expiresAt: new Date(Date.now() + 10 * 60_000)
  });

  await rpc('createwallet', [walletName]);
  const miningAddress = await rpc<string>('getnewaddress', ['', 'bech32'], walletName);
  await rpc('generatetoaddress', [101, miningAddress]);
  const unspent = await rpc<Array<{
    txid: string;
    vout: number;
    amount: number;
    confirmations: number;
    spendable: boolean;
  }>>('listunspent', [1, 9_999_999], walletName);
  const funding = unspent.find((item) => item.spendable && item.confirmations >= 101);
  assert.ok(funding);
  const destination = await rpc<string>('getnewaddress', ['', 'bech32'], walletName);
  const changeAddress = await rpc<string>('getrawchangeaddress', ['bech32'], walletName);

  const created = await request(app)
    .post('/v2/wallet/bitcoin/psbts')
    .set('Authorization', authorization)
    .send({
      network: 'regtest',
      scopeType: 'wallet',
      destination: 'bitcoin:' + destination + '?amount=1.00000000',
      amountAtomic: '100000000000',
      inputs: [{ txid: funding.txid, vout: funding.vout }],
      changeAddress,
      feeRateSatVb: '2',
      maxFeeAtomic: '10000000',
      minInputConfirmations: 100,
      requiredConfirmations: 1,
      idempotencyKey: 'bitcoin-core-live-regtest'
    })
    .expect(201);
  assert.equal(created.body.status, 'awaiting_signature');
  assert.equal(created.body.recipient.amountAtomic, '100000000000');
  assert.equal(created.body.inputs[0].txid, funding.txid);

  const signed = await rpc<{ psbt: string; complete: boolean }>('walletprocesspsbt', [created.body.psbt, true, 'ALL', true], walletName);
  assert.equal(signed.complete, true);
  const broadcast = await request(app)
    .post('/v2/wallet/bitcoin/psbts/' + created.body.id + '/submit')
    .set('Authorization', authorization)
    .send({ signedPsbt: signed.psbt })
    .expect(202);
  assert.equal(broadcast.body.status, 'broadcast');
  assert.match(broadcast.body.txid, /^[0-9a-f]{64}$/);

  const blockAddress = await rpc<string>('getnewaddress', ['', 'bech32'], walletName);
  await rpc('generatetoaddress', [1, blockAddress]);
  const confirmed = await request(app)
    .get('/v2/wallet/bitcoin/psbts/' + created.body.id)
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(confirmed.body.status, 'confirmed');
  assert.equal(confirmed.body.confirmations, 1);
  assert.equal(confirmed.body.txid, broadcast.body.txid);
} finally {
  await rpc('unloadwallet', [walletName]).catch(() => undefined);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
