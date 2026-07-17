import assert from 'node:assert/strict';
import { FiberConnector } from '../connectors/fiberConnector.js';
import type { PaymentConnector } from '../connectors/paymentConnector.js';
import { PaymentConnectorRegistry } from '../connectors/registry.js';
import { asAssetId, moneyValue, type PaymentIntent, type PaymentQuote, type PaymentResult } from '../domain/payment.js';
import { asAtomicAmount } from '../lib/money.js';
import { FiberAdapter } from '../services/fiberAdapter.js';
import type { FiberProvider } from '../services/fiberProvider.js';
import type { VaultPayoutInput, VaultPayoutResult } from '../services/vaultPayout.service.js';

const ckbAsset = asAssetId('ckb:ckb');
const paymentHash = '0x' + '42'.repeat(32);
const nowSeconds = Math.floor(Date.now() / 1000);

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    intentId: 'intent-connector-1',
    idempotencyKey: 'connector-idempotency-1',
    rail: 'fiber',
    network: 'testnet',
    money: moneyValue(ckbAsset, asAtomicAmount('2000000')),
    destination: {
      kind: 'invoice',
      rail: 'fiber',
      network: 'testnet',
      value: 'fiber-payment-request-connector-test'
    },
    ...overrides
  };
}

class FakeConnector implements PaymentConnector {
  readonly id = 'fake';

  capabilities() {
    return [{
      connectorId: this.id,
      rail: 'lightning' as const,
      network: 'regtest',
      assetId: asAssetId('bitcoin:btc'),
      destinationKinds: ['invoice' as const],
      supportsLookup: true,
      supportsRefund: false,
      funding: [{
        mode: 'connected_wallet' as const,
        guarantee: 'authorization_only' as const,
        requiresNetworkProof: false,
        supportsExecution: true,
        balanceSource: 'external_wallet' as const,
        failureStates: []
      }]
    }];
  }

  async validateDestination(input: PaymentIntent): Promise<void> {
    if (!input.destination.value) throw new Error('destination required');
  }

  async quote(input: PaymentIntent): Promise<PaymentQuote> {
    await this.validateDestination(input);
    return {
      quoteId: 'fake-quote',
      intentId: input.intentId,
      connectorId: this.id,
      amount: input.money,
      fee: moneyValue(input.money.assetId, '0'),
      total: input.money,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }

  async execute(input: PaymentIntent): Promise<PaymentResult> {
    return {
      intentId: input.intentId,
      status: 'succeeded',
      amount: input.money,
      connectorId: this.id,
      proof: { kind: 'payment_hash', reference: paymentHash, observedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString()
    };
  }

  async lookup() {
    return this.execute(intent({
      rail: 'lightning',
      network: 'regtest',
      money: moneyValue('bitcoin:btc', '1'),
      destination: { kind: 'invoice', rail: 'lightning', network: 'regtest', value: 'invoice' }
    }));
  }
}

const registry = new PaymentConnectorRegistry();
const fake = new FakeConnector();
registry.register(fake);
assert.equal(registry.require({ rail: 'lightning', network: 'REGTEST', assetId: asAssetId('bitcoin:btc') }), fake);
assert.equal(registry.capabilities()[0].connectorId, 'fake');
assert.throws(
  () => registry.require({ rail: 'bitcoin_onchain', network: 'regtest', assetId: asAssetId('bitcoin:btc') }),
  (error: unknown) => (error as { code?: string }).code === 'PAYMENT_CAPABILITY_UNSUPPORTED'
);
assert.throws(() => registry.register(fake), /already registered/);

let capturedPaymentRequest: string | undefined;
const provider: FiberProvider = {
  kind: 'rpc',
  network: 'testnet',
  async createSession() { throw new Error('not used'); },
  async parseInvoice() {
    return {
      amountMinor: 2_000_000,
      currency: 'Fibt',
      paymentHash,
      createdAtSeconds: nowSeconds,
      expiresAtSeconds: nowSeconds + 3600,
      hasUdtScript: false,
      signed: true
    };
  },
  async getPayment(reference) {
    return { provider: 'rpc', network: 'testnet', paymentHash: reference, status: 'Success' };
  },
  async authorizeCharge(input) {
    capturedPaymentRequest = input.paymentRequest;
    return { provider: 'rpc', network: 'testnet', authorized: true, proofId: paymentHash, status: 'Success' };
  },
  async topUpSession() { throw new Error('not used'); },
  async revokeSession() { throw new Error('not used'); },
  async settleSession() { throw new Error('not used'); },
  async getStatus(sessionId) { return { provider: 'rpc', network: 'testnet', status: 'pending', networkSessionId: sessionId }; }
};

const vaultPayout = async (_input: VaultPayoutInput): Promise<VaultPayoutResult> => ({
  provider: 'ckb-vault',
  network: 'testnet',
  proofId: '0x' + '77'.repeat(32)
});
const connector = new FiberConnector(new FiberAdapter(provider), provider, vaultPayout);
const fiberIntent = intent();
const quote = await connector.quote(fiberIntent);
assert.equal(connector.capabilities()[0].funding.find((item) => item.mode === 'secured_autopay')?.requiresNetworkProof, true);
assert.equal(connector.capabilities()[0].funding.find((item) => item.mode === 'connected_wallet')?.supportsExecution, false);
assert.equal(quote.connectorId, 'fiber-rpc');
assert.equal(quote.metadata?.providerCorrelationId, paymentHash);
assert.equal(quote.metadata?.invoiceAmountAtomic, '2000000');
const executed = await connector.execute(fiberIntent, quote, { sessionId: 'session-1', appAddress: 'ckt1app' });
assert.equal(executed.status, 'succeeded');
assert.equal(executed.proof?.kind, 'payment_hash');
assert.equal(executed.proof?.reference, paymentHash);
assert.equal(capturedPaymentRequest, fiberIntent.destination.value);
assert.equal('raw' in executed, false);
await assert.rejects(
  () => connector.execute({
    ...fiberIntent,
    destination: { ...fiberIntent.destination, value: 'substituted-payment-request' }
  }, quote),
  (error: unknown) => (error as { code?: string }).code === 'PAYMENT_QUOTE_MISMATCH'
);
const lookedUp = await connector.lookup({ rail: 'fiber', network: 'testnet', assetId: ckbAsset, reference: paymentHash });
assert.equal(lookedUp.status, 'succeeded');

await assert.rejects(
  () => connector.quote(intent({ network: 'mainnet' })),
  (error: unknown) => (error as { code?: string }).code === 'PAYMENT_NETWORK_UNSUPPORTED'
);
await assert.rejects(
  () => connector.quote(intent({ money: moneyValue(ckbAsset, '1') })),
  (error: unknown) => (error as { code?: string }).code === 'FIBER_INVOICE_AMOUNT_MISMATCH'
);

const ckbAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const ckbIntent = intent({
  rail: 'ckb_onchain',
  money: moneyValue(ckbAsset, '20000000000'),
  destination: { kind: 'address', rail: 'ckb_onchain', network: 'testnet', value: ckbAddress }
});
const ckbQuote = await connector.quote(ckbIntent);
assert.ok(BigInt(ckbQuote.metadata?.minimumAmountAtomic ?? '0') > 0n);
const ckbResult = await connector.execute(ckbIntent, ckbQuote, { ownerWalletId: 'owner-1', sessionId: 'session-1' });
assert.equal(ckbResult.proof?.kind, 'transaction');

const leakingProvider: FiberProvider = {
  ...provider,
  async authorizeCharge() { throw new Error('rpc secret https://operator.internal'); }
};
const leakingConnector = new FiberConnector(new FiberAdapter(leakingProvider), leakingProvider, vaultPayout);
const leakingQuote = await leakingConnector.quote(fiberIntent);
await assert.rejects(
  () => leakingConnector.execute(fiberIntent, leakingQuote),
  (error: unknown) => {
    const publicError = error as { code?: string; message?: string };
    return publicError.code === 'PAYMENT_CONNECTOR_EXECUTION_FAILED'
      && publicError.message === 'Payment connector execution failed.'
      && !publicError.message.includes('operator.internal');
  }
);
