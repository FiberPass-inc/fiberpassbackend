import { bech32 } from 'bech32';
import { z } from 'zod';
import { env } from '../config/env.js';
import { DestinationResolverClient, type ResolverTransport } from '../connectors/destinationResolverClient.js';
import { paymentConnectorRegistry } from '../connectors/index.js';
import { decodeLightningInvoice } from '../connectors/nwcProtocol.js';
import { asAssetId, moneyValue, type PaymentIntent, type PaymentRail } from '../domain/payment.js';
import { paymentRequestHash } from '../domain/schedule.js';
import type { DestinationKind } from '../domain/identity.js';
import { ApiError } from '../lib/errors.js';
import { asAtomicAmount, parseAtomicAmount } from '../lib/money.js';

const lightningAddressPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const lnurlMetadataSchema = z.object({
  tag: z.literal('payRequest'),
  callback: z.string().url(),
  minSendable: z.union([z.number().int().nonnegative(), z.string().regex(/^(0|[1-9]\d*)$/)]),
  maxSendable: z.union([z.number().int().nonnegative(), z.string().regex(/^(0|[1-9]\d*)$/)])
}).passthrough();
const lnurlInvoiceSchema = z.object({ pr: z.string().trim().min(20).max(5000) }).passthrough();
const endpointResponseSchema = z.object({
  paymentRequest: z.string().trim().min(16).max(10_000),
  rail: z.enum(['lightning', 'fiber']),
  network: z.string().trim().min(1).max(80),
  assetId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._:-]{0,127}$/),
  amountAtomic: z.string().regex(/^[1-9]\d*$/),
  recipientId: z.string().trim().min(1).max(160),
  expiresAt: z.string().datetime()
}).strict();

export interface ReusableDestinationInput {
  destinationId: string;
  recipientId: string;
  rail: PaymentRail;
  network: string;
  assetId: string;
  kind: DestinationKind;
  value: string;
  resolverEndpoint?: string;
}

export interface ResolveFreshRequestInput {
  occurrenceId: string;
  dueAt: Date;
  destination: ReusableDestinationInput;
  amountAtomic: string;
  now?: Date;
}

export interface ResolvedFreshRequest {
  paymentRequest: string;
  paymentRequestHash: string;
  paymentHash?: string;
  expiresAt: Date;
}

const defaultTransport = new DestinationResolverClient({
  timeoutMs: env.SCHEDULE_RESOLVER_TIMEOUT_MS,
  allowInsecureLocal: env.SCHEDULE_ALLOW_INSECURE_LOCAL_RESOLVERS
});

export function lightningAddressUrl(address: string): string {
  const normalized = address.trim();
  if (!lightningAddressPattern.test(normalized)) {
    throw new ApiError(400, 'LIGHTNING_ADDRESS_INVALID', 'Lightning Address format is invalid.');
  }
  const separator = normalized.lastIndexOf('@');
  const user = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1).toLowerCase();
  return 'https://' + domain + '/.well-known/lnurlp/' + encodeURIComponent(user);
}

export function decodeLnurl(value: string): string {
  try {
    const decoded = bech32.decode(value.trim().toLowerCase(), 2000);
    if (decoded.prefix !== 'lnurl') throw new Error('prefix');
    return Buffer.from(bech32.fromWords(decoded.words)).toString('utf8');
  } catch {
    throw new ApiError(400, 'LNURL_INVALID', 'LNURL destination is invalid.');
  }
}

function exactProviderAmount(value: string | number): bigint {
  const normalized = typeof value === 'number' ? value.toString(10) : value;
  try {
    return parseAtomicAmount(normalized);
  } catch {
    throw new ApiError(502, 'DESTINATION_RESOLVER_AMOUNT_INVALID', 'Payment resolver returned an invalid amount.');
  }
}

async function resolveLnurlInvoice(input: ResolveFreshRequestInput, transport: ResolverTransport): Promise<string> {
  const metadataUrl = input.destination.kind === 'lightning_address'
    ? lightningAddressUrl(input.destination.value)
    : decodeLnurl(input.destination.value);
  const metadata = lnurlMetadataSchema.parse(await transport.requestJson({ url: metadataUrl, method: 'GET' }));
  const amount = parseAtomicAmount(asAtomicAmount(input.amountAtomic));
  if (amount < exactProviderAmount(metadata.minSendable) || amount > exactProviderAmount(metadata.maxSendable)) {
    throw new ApiError(400, 'LNURL_AMOUNT_OUT_OF_RANGE', 'Scheduled amount is outside the LNURL receiver range.');
  }
  const callback = new URL(metadata.callback);
  callback.searchParams.set('amount', amount.toString(10));
  const response = lnurlInvoiceSchema.parse(await transport.requestJson({ url: callback.toString(), method: 'GET' }));
  return response.pr;
}

async function resolveEndpointInvoice(input: ResolveFreshRequestInput, transport: ResolverTransport): Promise<{
  paymentRequest: string;
  expiresAt: Date;
}> {
  const endpoint = input.destination.kind === 'endpoint'
    ? input.destination.value
    : input.destination.resolverEndpoint;
  if (!endpoint) {
    throw new ApiError(400, 'BOLT12_RESOLVER_REQUIRED', 'This BOLT12 offer requires a configured offer-capable resolver endpoint.');
  }
  const response = endpointResponseSchema.parse(await transport.requestJson({
    url: endpoint,
    method: 'POST',
    body: {
      contractVersion: '2.0',
      occurrenceId: input.occurrenceId,
      dueAt: input.dueAt.toISOString(),
      recipientId: input.destination.recipientId,
      destinationId: input.destination.destinationId,
      rail: input.destination.rail,
      network: input.destination.network,
      assetId: input.destination.assetId,
      amountAtomic: asAtomicAmount(input.amountAtomic),
      ...(input.destination.kind === 'bolt12_offer' ? { offer: input.destination.value } : {})
    }
  }));
  if (
    response.recipientId !== input.destination.recipientId
    || response.rail !== input.destination.rail
    || response.network.toLowerCase() !== input.destination.network.toLowerCase()
    || response.assetId !== input.destination.assetId
    || parseAtomicAmount(response.amountAtomic) !== parseAtomicAmount(input.amountAtomic)
  ) {
    throw new ApiError(400, 'DESTINATION_RESOLVER_CONTRACT_MISMATCH', 'Resolved request does not match the authorized recipient, rail, network, asset, or amount.');
  }
  return { paymentRequest: response.paymentRequest, expiresAt: new Date(response.expiresAt) };
}

async function validateFiberRequest(input: ResolveFreshRequestInput, paymentRequest: string, now: Date): Promise<Date> {
  const intent: PaymentIntent = {
    intentId: input.occurrenceId,
    idempotencyKey: input.occurrenceId,
    rail: 'fiber',
    network: input.destination.network,
    money: moneyValue(input.destination.assetId, input.amountAtomic),
    destination: {
      kind: 'invoice',
      rail: 'fiber',
      network: input.destination.network,
      value: paymentRequest
    }
  };
  const connector = paymentConnectorRegistry.require({
    rail: 'fiber',
    network: input.destination.network,
    assetId: asAssetId(input.destination.assetId)
  });
  await connector.validateDestination(intent);
  const quote = await connector.quote(intent);
  if (parseAtomicAmount(quote.amount.amountAtomic) !== parseAtomicAmount(input.amountAtomic)) {
    throw new ApiError(400, 'FIBER_INVOICE_AMOUNT_MISMATCH', 'Resolved Fiber invoice amount does not match the schedule.');
  }
  const expiresAt = new Date(quote.expiresAt);
  if (expiresAt.getTime() <= now.getTime()) throw new ApiError(410, 'FIBER_INVOICE_EXPIRED', 'Resolved Fiber invoice has expired.');
  return expiresAt;
}

export async function resolveFreshPaymentRequest(
  input: ResolveFreshRequestInput,
  transport: ResolverTransport = defaultTransport
): Promise<ResolvedFreshRequest> {
  if (input.destination.kind === 'invoice' || input.destination.kind === 'address') {
    throw new ApiError(400, 'REUSABLE_DESTINATION_REQUIRED', 'Scheduled request resolution requires a reusable endpoint, offer, LNURL, or Lightning Address.');
  }
  if (input.destination.kind === 'bolt12_offer' && !/^lno1[02-9ac-hj-np-z]+$/i.test(input.destination.value.trim())) {
    throw new ApiError(400, 'BOLT12_OFFER_INVALID', 'BOLT12 offer encoding is invalid.');
  }
  const now = input.now ?? new Date();
  let paymentRequest: string;
  let responseExpiry: Date | undefined;
  if (input.destination.kind === 'lnurl' || input.destination.kind === 'lightning_address') {
    if (input.destination.rail !== 'lightning' || input.destination.assetId !== 'bitcoin:btc') {
      throw new ApiError(400, 'LNURL_ASSET_UNSUPPORTED', 'LNURL schedules currently require Lightning BTC.');
    }
    paymentRequest = await resolveLnurlInvoice(input, transport);
  } else {
    const resolved = await resolveEndpointInvoice(input, transport);
    paymentRequest = resolved.paymentRequest;
    responseExpiry = resolved.expiresAt;
  }

  if (input.destination.rail === 'lightning') {
    const decoded = decodeLightningInvoice({
      invoice: paymentRequest,
      network: input.destination.network as 'mainnet' | 'testnet' | 'signet' | 'regtest',
      expectedAmountAtomic: asAtomicAmount(input.amountAtomic),
      now
    });
    const expiresAt = new Date(decoded.expiresAt);
    if (responseExpiry && responseExpiry.getTime() !== expiresAt.getTime()) {
      throw new ApiError(400, 'DESTINATION_RESOLVER_EXPIRY_MISMATCH', 'Resolver expiry does not match the resolved Lightning invoice.');
    }
    return {
      paymentRequest: decoded.invoice,
      paymentRequestHash: paymentRequestHash(decoded.invoice),
      paymentHash: decoded.paymentHash,
      expiresAt
    };
  }
  if (input.destination.rail === 'fiber') {
    const connectorExpiry = await validateFiberRequest(input, paymentRequest, now);
    if (responseExpiry && responseExpiry.getTime() !== connectorExpiry.getTime()) {
      throw new ApiError(400, 'DESTINATION_RESOLVER_EXPIRY_MISMATCH', 'Resolver expiry does not match the resolved Fiber request.');
    }
    return {
      paymentRequest,
      paymentRequestHash: paymentRequestHash(paymentRequest),
      expiresAt: connectorExpiry
    };
  }
  throw new ApiError(400, 'SCHEDULE_RAIL_UNSUPPORTED', 'Fresh scheduled requests support Lightning and Fiber rails.');
}
