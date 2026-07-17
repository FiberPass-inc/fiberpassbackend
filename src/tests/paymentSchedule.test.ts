import assert from 'node:assert/strict';
import { bech32 } from 'bech32';
import { DestinationResolverClient, type ResolverTransport } from '../connectors/destinationResolverClient.js';
import { decodeLightningInvoice } from '../connectors/nwcProtocol.js';
import {
  assertTimeZone,
  nextOccurrenceAfter,
  occurrenceLocalDay,
  stableOccurrenceId
} from '../domain/schedule.js';
import {
  decodeLnurl,
  lightningAddressUrl,
  resolveFreshPaymentRequest
} from '../services/destinationResolver.service.js';
import { MockNwcRelayWallet } from './nwcTestWallet.js';

const dailyBeforeDst = new Date('2026-03-07T14:00:00.000Z');
assert.equal(
  nextOccurrenceAfter(dailyBeforeDst, { cadence: 'daily', timeZone: 'America/New_York' })?.toISOString(),
  '2026-03-08T13:00:00.000Z'
);
assert.equal(
  nextOccurrenceAfter(new Date('2026-03-04T14:00:00.000Z'), { cadence: 'weekly', timeZone: 'America/New_York' })?.toISOString(),
  '2026-03-11T13:00:00.000Z'
);

const january31 = new Date('2027-01-31T09:30:00.000Z');
const february = nextOccurrenceAfter(january31, { cadence: 'monthly', timeZone: 'UTC', anchorDay: 31 });
assert.equal(february?.toISOString(), '2027-02-28T09:30:00.000Z');
assert.equal(
  nextOccurrenceAfter(february as Date, { cadence: 'monthly', timeZone: 'UTC', anchorDay: 31 })?.toISOString(),
  '2027-03-31T09:30:00.000Z'
);
assert.equal(occurrenceLocalDay(january31, 'UTC'), 31);
assert.equal(
  nextOccurrenceAfter(new Date('2026-01-01T00:00:00.000Z'), { cadence: 'custom', timeZone: 'Pacific/Auckland', customIntervalSeconds: 90 })?.toISOString(),
  '2026-01-01T00:01:30.000Z'
);
assert.equal(nextOccurrenceAfter(january31, { cadence: 'once', timeZone: 'UTC' }), undefined);
assert.throws(() => assertTimeZone('Mars/Olympus_Mons'), /IANA/);
assert.throws(() => nextOccurrenceAfter(january31, { cadence: 'custom', timeZone: 'UTC' }), /interval/);

const occurrenceId = stableOccurrenceId('sch_example', january31);
assert.equal(occurrenceId, stableOccurrenceId('sch_example', new Date(january31)));
assert.notEqual(occurrenceId, stableOccurrenceId('sch_example', new Date(january31.getTime() + 1)));

const lnurlTarget = 'https://pay.example.com/lnurl/callback';
const encodedLnurl = bech32.encode('lnurl', bech32.toWords(Buffer.from(lnurlTarget)), 2000);
assert.equal(decodeLnurl(encodedLnurl), lnurlTarget);
assert.equal(lightningAddressUrl('alice@Example.com'), 'https://example.com/.well-known/lnurlp/alice');
assert.throws(() => lightningAddressUrl('not-an-address'), /format/);

const secureClient = new DestinationResolverClient();
await assert.rejects(() => secureClient.assertUrl('http://example.com/resolve'), (error: unknown) => (
  (error as { code?: string }).code === 'DESTINATION_RESOLVER_HTTPS_REQUIRED'
));
await assert.rejects(() => secureClient.assertUrl('https://127.0.0.1/resolve'), (error: unknown) => (
  (error as { code?: string }).code === 'DESTINATION_RESOLVER_ADDRESS_FORBIDDEN'
));

const wallet = new MockNwcRelayWallet({ network: 'regtest' });
const invoice = wallet.createInvoice({ preimage: 'ab'.repeat(32), amount: '2500000', expirySeconds: 3600 });
const decoded = decodeLightningInvoice({ invoice: invoice.invoice, network: 'regtest' });
const lnurlCalls: string[] = [];
const lnurlTransport: ResolverTransport = {
  async requestJson(input) {
    lnurlCalls.push(input.url);
    if (input.url === lnurlTarget) {
      return { tag: 'payRequest', callback: 'https://pay.example.com/fresh', minSendable: '1000', maxSendable: '5000000' };
    }
    assert.equal(new URL(input.url).searchParams.get('amount'), '2500000');
    return { pr: invoice.invoice };
  }
};
const lnurlResolved = await resolveFreshPaymentRequest({
  occurrenceId,
  dueAt: january31,
  destination: {
    destinationId: 'dst_lnurl',
    recipientId: 'rcp_alice',
    rail: 'lightning',
    network: 'regtest',
    assetId: 'bitcoin:btc',
    kind: 'lnurl',
    value: encodedLnurl
  },
  amountAtomic: '2500000'
}, lnurlTransport);
assert.equal(lnurlCalls.length, 2);
assert.equal(lnurlResolved.paymentHash, invoice.paymentHash);
assert.equal(lnurlResolved.expiresAt.toISOString(), decoded.expiresAt);
assert.equal(lnurlResolved.paymentRequest.includes('ab'.repeat(32)), false);

const endpointTransport = (recipientId: string): ResolverTransport => ({
  async requestJson(input) {
    assert.equal(input.method, 'POST');
    assert.equal(input.body?.occurrenceId, occurrenceId);
    if (input.url.includes('offers.example.com')) assert.equal(input.body?.offer, 'lno1qqqqqqqq');
    else assert.equal(input.body?.offer, undefined);
    return {
      paymentRequest: invoice.invoice,
      rail: 'lightning',
      network: 'regtest',
      assetId: 'bitcoin:btc',
      amountAtomic: '2500000',
      recipientId,
      expiresAt: decoded.expiresAt
    };
  }
});
const bolt12Resolved = await resolveFreshPaymentRequest({
  occurrenceId,
  dueAt: january31,
  destination: {
    destinationId: 'dst_bolt12',
    recipientId: 'rcp_alice',
    rail: 'lightning',
    network: 'regtest',
    assetId: 'bitcoin:btc',
    kind: 'bolt12_offer',
    value: 'lno1qqqqqqqq',
    resolverEndpoint: 'https://offers.example.com/resolve'
  },
  amountAtomic: '2500000'
}, endpointTransport('rcp_alice'));
assert.equal(bolt12Resolved.paymentHash, invoice.paymentHash);

await assert.rejects(() => resolveFreshPaymentRequest({
  occurrenceId,
  dueAt: january31,
  destination: {
    destinationId: 'dst_endpoint',
    recipientId: 'rcp_alice',
    rail: 'lightning',
    network: 'regtest',
    assetId: 'bitcoin:btc',
    kind: 'endpoint',
    value: 'https://recipient.example.com/fresh'
  },
  amountAtomic: '2500000'
}, endpointTransport('rcp_mallory')), (error: unknown) => (
  (error as { code?: string }).code === 'DESTINATION_RESOLVER_CONTRACT_MISMATCH'
));

await assert.rejects(() => resolveFreshPaymentRequest({
  occurrenceId,
  dueAt: january31,
  destination: {
    destinationId: 'dst_lnurl',
    recipientId: 'rcp_alice',
    rail: 'lightning',
    network: 'regtest',
    assetId: 'bitcoin:btc',
    kind: 'lnurl',
    value: encodedLnurl
  },
  amountAtomic: '9000000'
}, lnurlTransport), (error: unknown) => (
  (error as { code?: string }).code === 'LNURL_AMOUNT_OUT_OF_RANGE'
));
