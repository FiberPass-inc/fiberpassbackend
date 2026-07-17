import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { asAssetId, moneyValue, type PaymentIntent, type PaymentQuote, type PaymentResult } from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import type { ConnectorCapability, ConnectorLookupInput, PaymentConnector } from './paymentConnector.js';
import { parseBitcoinDestination } from './bitcoinProtocol.js';
import { bitcoinCoreClient, type BitcoinCoreClient } from './bitcoinCoreClient.js';

const BTC_ASSET_ID = asAssetId('bitcoin:btc');

function quoteId(intent: PaymentIntent): string {
  return 'quote_psbt_' + createHash('sha256').update(JSON.stringify(intent)).digest('hex').slice(0, 24);
}

export class BitcoinPsbtConnector implements PaymentConnector {
  readonly id = 'bitcoin-core-psbt';

  constructor(private readonly core: BitcoinCoreClient = bitcoinCoreClient) {}

  capabilities(): readonly ConnectorCapability[] {
    return [{
      connectorId: this.id,
      rail: 'bitcoin_onchain',
      network: env.BITCOIN_NETWORK,
      assetId: BTC_ASSET_ID,
      destinationKinds: ['address', 'psbt_output'],
      supportsLookup: true,
      supportsRefund: false,
      funding: [{
        mode: 'connected_wallet',
        guarantee: 'authorization_only',
        requiresNetworkProof: false,
        supportsExecution: false,
        balanceSource: 'external_wallet',
        failureStates: ['BITCOIN_WALLET_SIGNATURE_REQUIRED', 'BITCOIN_PSBT_REJECTED', 'BITCOIN_CONFIRMATION_PENDING']
      }]
    }];
  }

  async validateDestination(intent: PaymentIntent): Promise<void> {
    if (intent.rail !== 'bitcoin_onchain' || intent.money.assetId !== BTC_ASSET_ID || !['address', 'psbt_output'].includes(intent.destination.kind)) {
      throw new ApiError(400, 'BITCOIN_PSBT_INTENT_UNSUPPORTED', 'Bitcoin PSBT execution requires an on-chain BTC destination.');
    }
    parseBitcoinDestination({
      destination: intent.destination.value,
      network: intent.network as typeof env.BITCOIN_NETWORK,
      expectedAmountAtomic: intent.money.amountAtomic
    });
  }

  async quote(intent: PaymentIntent): Promise<PaymentQuote> {
    await this.validateDestination(intent);
    return {
      quoteId: quoteId(intent),
      intentId: intent.intentId,
      connectorId: this.id,
      amount: intent.money,
      fee: moneyValue(BTC_ASSET_ID, '0'),
      total: intent.money,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      metadata: { interactionRequired: 'wallet_psbt_signature' }
    };
  }

  async execute(intent: PaymentIntent, quote: PaymentQuote): Promise<PaymentResult> {
    if (quote.connectorId !== this.id || quote.quoteId !== quoteId(intent)) {
      throw new ApiError(409, 'BITCOIN_PSBT_QUOTE_INVALID', 'Bitcoin PSBT quote is invalid or changed.');
    }
    throw new ApiError(409, 'BITCOIN_WALLET_SIGNATURE_REQUIRED', 'Bitcoin payment requires the user wallet to sign the reviewed PSBT.');
  }

  async lookup(input: ConnectorLookupInput): Promise<PaymentResult> {
    if (!/^[0-9a-f]{64}$/i.test(input.reference)) throw new ApiError(400, 'BITCOIN_TXID_INVALID', 'Bitcoin transaction id is invalid.');
    try {
      const transaction = await this.core.getRawTransaction(input.reference.toLowerCase());
      const confirmations = transaction.confirmations ?? 0;
      return {
        intentId: input.reference,
        status: confirmations > 0 ? 'succeeded' : 'pending',
        amount: moneyValue(BTC_ASSET_ID, '0'),
        connectorId: this.id,
        connectorReference: transaction.txid,
        proof: confirmations > 0 ? {
          kind: 'transaction',
          reference: transaction.txid,
          network: input.network,
          observedAt: new Date().toISOString(),
          metadata: { confirmations: confirmations.toString(10), blockHash: transaction.blockhash ?? '' }
        } : undefined,
        updatedAt: new Date().toISOString()
      };
    } catch {
      return {
        intentId: input.reference,
        status: 'uncertain',
        amount: moneyValue(BTC_ASSET_ID, '0'),
        connectorId: this.id,
        connectorReference: input.reference,
        updatedAt: new Date().toISOString()
      };
    }
  }
}

export const bitcoinPsbtConnector = new BitcoinPsbtConnector();
