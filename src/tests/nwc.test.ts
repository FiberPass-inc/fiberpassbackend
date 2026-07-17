import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as bolt11 from 'bolt11';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { NWC_INFO_KIND } from '../domain/nwc.js';
import { decodeLightningInvoice, parseNwcConnectionUri, parseNwcInfoEvent, verifyLightningPreimage } from '../connectors/nwcProtocol.js';
import { decryptNwcSecret, encryptNwcSecret } from '../services/nwcCredential.service.js';

const encryptionKey = '11'.repeat(32);
const walletSecret = generateSecretKey();
const walletPubkey = getPublicKey(walletSecret);
const clientSecret = generateSecretKey();
const uri = 'nostr+walletconnect://' + walletPubkey
  + '?relay=' + encodeURIComponent('wss://relay.example.com')
  + '&secret=' + Buffer.from(clientSecret).toString('hex');
const parsed = parseNwcConnectionUri(uri);
assert.equal(parsed.walletPubkey, walletPubkey);
assert.equal(parsed.clientPubkey, getPublicKey(clientSecret));
assert.deepEqual(parsed.relays, ['wss://relay.example.com/']);

const encrypted = encryptNwcSecret(clientSecret, encryptionKey);
assert.ok(!encrypted.includes(Buffer.from(clientSecret).toString('hex')));
assert.deepEqual(decryptNwcSecret(encrypted, encryptionKey), clientSecret);
assert.throws(() => decryptNwcSecret(encrypted, '22'.repeat(32)), /could not be decrypted/);

const infoEvent = finalizeEvent({
  kind: NWC_INFO_KIND,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['encryption', 'nip04 nip44_v2'], ['notifications', 'payment_sent']],
  content: 'pay_invoice get_balance lookup_invoice custom_method'
}, walletSecret);
const info = parseNwcInfoEvent(infoEvent, walletPubkey);
assert.equal(info.encryption, 'nip44_v2');
assert.deepEqual(info.methods, ['pay_invoice', 'get_balance', 'lookup_invoice']);
assert.deepEqual(info.notifications, ['payment_sent']);

const legacyInfo = parseNwcInfoEvent(finalizeEvent({
  kind: NWC_INFO_KIND,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: 'pay_invoice'
}, walletSecret), walletPubkey);
assert.equal(legacyInfo.encryption, 'nip04');

const preimage = '33'.repeat(32);
const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
const encoded = bolt11.encode({
  network: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  millisatoshis: '1234567',
  timestamp: Math.floor(Date.now() / 1000),
  tags: [
    { tagName: 'payment_hash', data: paymentHash },
    { tagName: 'description', data: 'NWC protocol fixture' },
    { tagName: 'expire_time', data: 3600 }
  ]
});
const invoice = bolt11.sign(encoded, Buffer.alloc(32, 9)).paymentRequest;
assert.ok(invoice);
const decoded = decodeLightningInvoice({ invoice, network: 'regtest', expectedAmountAtomic: '1234567' });
assert.equal(decoded.paymentHash, paymentHash);
assert.equal(decoded.amountAtomic, '1234567');
assert.equal(verifyLightningPreimage(preimage, paymentHash), true);
assert.equal(verifyLightningPreimage('44'.repeat(32), paymentHash), false);
assert.throws(
  () => decodeLightningInvoice({ invoice, network: 'regtest', expectedAmountAtomic: '1234568' }),
  /amount does not match/
);
assert.throws(() => decodeLightningInvoice({ invoice, network: 'mainnet' }), /another network/);

const signetEncoded = bolt11.encode({
  network: { bech32: 'tbs', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  millisatoshis: '2000',
  timestamp: Math.floor(Date.now() / 1000),
  tags: [
    { tagName: 'payment_hash', data: paymentHash },
    { tagName: 'description', data: 'Signet prefix fixture' },
    { tagName: 'expire_time', data: 3600 }
  ]
});
const signetInvoice = bolt11.sign(signetEncoded, Buffer.alloc(32, 9)).paymentRequest;
assert.ok(signetInvoice);
assert.ok(signetInvoice.startsWith('lntbs'));
assert.equal(decodeLightningInvoice({ invoice: signetInvoice, network: 'signet' }).network, 'signet');
assert.throws(() => decodeLightningInvoice({ invoice: signetInvoice, network: 'testnet' }), /another network/);

const expiredEncoded = bolt11.encode({
  network: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  millisatoshis: '1000',
  timestamp: Math.floor(Date.now() / 1000) - 120,
  tags: [
    { tagName: 'payment_hash', data: paymentHash },
    { tagName: 'description', data: 'Expired fixture' },
    { tagName: 'expire_time', data: 60 }
  ]
});
const expiredInvoice = bolt11.sign(expiredEncoded, Buffer.alloc(32, 9)).paymentRequest;
assert.ok(expiredInvoice);
assert.throws(() => decodeLightningInvoice({ invoice: expiredInvoice, network: 'regtest' }), /expired/);

assert.throws(
  () => parseNwcConnectionUri(uri + '&secret=' + '44'.repeat(32)),
  (error: unknown) => !String((error as Error).message).includes(Buffer.from(clientSecret).toString('hex'))
);
