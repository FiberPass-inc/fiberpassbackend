import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networks, payments } from 'bitcoinjs-lib';
import { BtcpayGreenfieldClient } from '../connectors/btcpayClient.js';
import {
  bitcoinAddressScript,
  formatMsatAsBtc,
  msatToSats,
  parseBitcoinDestination,
  parseBtcDecimalToMsat,
  satsToMsat,
  supportedFundingInputType
} from '../connectors/bitcoinProtocol.js';
import { decryptBtcpayApiKey, encryptBtcpayApiKey } from '../services/btcpayCredential.service.js';

const recipient = payments.p2wpkh({ hash: Buffer.alloc(20, 1), network: networks.regtest }).address;
const mainnetRecipient = payments.p2wpkh({ hash: Buffer.alloc(20, 2), network: networks.bitcoin }).address;
assert.ok(recipient);
assert.ok(mainnetRecipient);

assert.equal(parseBtcDecimalToMsat('1.00000000001'), '100000000001');
assert.equal(parseBtcDecimalToMsat('0.00000001', { onchain: true }), '1000');
assert.equal(formatMsatAsBtc('100000000001'), '1.00000000001');
assert.equal(msatToSats('9007199254740993000'), 9007199254740993n);
assert.equal(satsToMsat(9007199254740993n), '9007199254740993000');
assert.throws(
  () => parseBtcDecimalToMsat('0.000000001', { onchain: true }),
  (error: unknown) => (error as { code?: string }).code === 'BITCOIN_AMOUNT_NOT_SATOSHI_ALIGNED'
);
assert.throws(() => parseBtcDecimalToMsat('21000000.00000000001'), /outside the Bitcoin supply range/);

const destination = parseBitcoinDestination({
  destination: 'bitcoin:' + recipient + '?amount=0.00001000&label=FiberPass&message=Exact',
  network: 'regtest',
  expectedAmountAtomic: '1000000'
});
assert.equal(destination.address, recipient);
assert.equal(destination.amountAtomic, '1000000');
assert.equal(destination.label, 'FiberPass');
assert.equal(destination.message, 'Exact');
assert.equal(supportedFundingInputType(destination.scriptHex), 'p2wpkh');
assert.deepEqual(Buffer.from(bitcoinAddressScript(recipient, 'regtest')), Buffer.from(destination.scriptHex, 'hex'));
assert.throws(
  () => parseBitcoinDestination({ destination: 'bitcoin:' + recipient + '?amount=0.00002000', network: 'regtest', expectedAmountAtomic: '1000000' }),
  (error: unknown) => (error as { code?: string }).code === 'BITCOIN_DESTINATION_AMOUNT_MISMATCH'
);
assert.throws(
  () => parseBitcoinDestination({ destination: 'bitcoin:' + recipient + '?req-feature=1', network: 'regtest' }),
  (error: unknown) => (error as { code?: string }).code === 'BIP21_REQUIRED_PARAMETER_UNSUPPORTED'
);
assert.throws(
  () => parseBitcoinDestination({ destination: mainnetRecipient, network: 'regtest' }),
  (error: unknown) => (error as { code?: string }).code === 'BITCOIN_ADDRESS_NETWORK_MISMATCH'
);
assert.throws(() => supportedFundingInputType('76a914' + '01'.repeat(20) + '88ac'), /native SegWit or Taproot/);

const encryptionKey = 'ab'.repeat(32);
const apiKey = 'FiberPassScopedApiKey_1234567890';
const encrypted = encryptBtcpayApiKey(apiKey, encryptionKey);
assert.ok(!encrypted.includes(apiKey));
assert.equal(decryptBtcpayApiKey(encrypted, encryptionKey), apiKey);
assert.throws(() => decryptBtcpayApiKey(encrypted, 'cd'.repeat(32)), /could not be decrypted/);

let observedAuthorization = '';
const server = createServer((request, response) => {
  observedAuthorization = String(request.headers.authorization ?? '');
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as AddressInfo;
const localOrigin = 'http://127.0.0.1:' + address.port + '/';
try {
  const lockedClient = new BtcpayGreenfieldClient({ timeoutMs: 1000 });
  await assert.rejects(
    () => lockedClient.request({ serverUrl: localOrigin, apiKey, method: 'GET', path: '/api/v1/health' }),
    (error: unknown) => (error as { code?: string }).code === 'BTCPAY_HTTPS_REQUIRED'
  );
  await assert.rejects(
    () => lockedClient.request({ serverUrl: 'https://127.0.0.1/', apiKey, method: 'GET', path: '/api/v1/health' }),
    (error: unknown) => (error as { code?: string }).code === 'BTCPAY_DESTINATION_FORBIDDEN'
  );
  const fixtureClient = new BtcpayGreenfieldClient({ timeoutMs: 1000, allowInsecureLocal: true });
  const response = await fixtureClient.request<{ ok: boolean }>({
    serverUrl: localOrigin,
    apiKey,
    method: 'GET',
    path: '/api/v1/health'
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(observedAuthorization, 'token ' + apiKey);
  await assert.rejects(
    () => fixtureClient.request({ serverUrl: localOrigin, apiKey, method: 'GET', path: '/api/v1/../secrets' }),
    (error: unknown) => (error as { code?: string }).code === 'BTCPAY_PATH_INVALID'
  );
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
