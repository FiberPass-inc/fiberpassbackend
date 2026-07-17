import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as bolt11 from 'bolt11';
import { networks, payments, Psbt, Transaction } from 'bitcoinjs-lib';
import { requiredBtcpayPermissions } from '../domain/bitcoin.js';

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function listeningUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return 'http://127.0.0.1:' + address.port + '/';
}

interface FixtureInvoice {
  id: string;
  storeId: string;
  amount: string;
  currency: 'BTC';
  status: 'New' | 'Settled';
  checkoutLink: string;
  expirationTime: number;
  metadata: { orderId: string };
  paymentMethods: Array<{ paymentMethodId: 'BTC-LN' | 'BTC-CHAIN'; destination: string; paymentLink: string; amount: string }>;
}

interface FixturePayment {
  id: string;
  status: 'Complete';
  paymentHash: string;
  preimage: string;
  totalAmount: string;
  feeAmount: string;
}

export class MockBtcpayServer {
  readonly storeId = 'fiberpass-regtest-store';
  readonly apiKey = 'FiberPassScopedKey_12345678901234567890';
  readonly broadApiKey = 'FiberPassBroadKey_123456789012345678901';
  invoiceCreateCalls = 0;
  lightningPayCalls = 0;
  invoiceLookupCalls = 0;
  paymentLookupCalls = 0;
  dropNextInvoiceResponse = false;
  dropNextPaymentResponse = false;
  revokedKeys = new Set<string>();

  private server?: Server;
  private originValue = '';
  private invoiceCounter = 0;
  private paymentCounter = 0;
  private readonly invoices = new Map<string, FixtureInvoice>();
  private readonly outgoing = new Map<string, { amountAtomic: string; paymentHash: string; preimage: string }>();
  private readonly payments = new Map<string, FixturePayment>();
  private readonly receiveAddress = payments.p2wpkh({ hash: Buffer.alloc(20, 7), network: networks.regtest }).address as string;

  get origin(): string {
    if (!this.originValue) throw new Error('Mock BTCPay server is not started.');
    return this.originValue;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.originValue = listeningUrl(this.server);
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
  }

  createOutgoingInvoice(input: { amountAtomic: string; preimage: string }): { invoice: string; paymentHash: string } {
    const paymentHash = createHash('sha256').update(Buffer.from(input.preimage, 'hex')).digest('hex');
    const encoded = bolt11.encode({
      network: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
      millisatoshis: input.amountAtomic,
      timestamp: Math.floor(Date.now() / 1000),
      tags: [
        { tagName: 'payment_hash', data: paymentHash },
        { tagName: 'description', data: 'FiberPass BTCPay fixture payment' },
        { tagName: 'expire_time', data: 3600 }
      ]
    });
    const invoice = bolt11.sign(encoded, Buffer.alloc(32, 5)).paymentRequest;
    if (!invoice) throw new Error('BTCPay fixture could not sign BOLT11 invoice.');
    this.outgoing.set(invoice.toLowerCase(), { ...input, paymentHash });
    return { invoice, paymentHash };
  }

  private requestApiKey(request: IncomingMessage): string {
    return String(request.headers.authorization ?? '').replace(/^token /, '');
  }

  private permissions(apiKey: string): string[] {
    const required = requiredBtcpayPermissions(this.storeId);
    return apiKey === this.broadApiKey ? [...required, 'btcpay.store.canmodifystoresettings:' + this.storeId] : required;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', this.origin);
    const apiKey = this.requestApiKey(request);
    if (![this.apiKey, this.broadApiKey].includes(apiKey) || this.revokedKeys.has(apiKey)) {
      json(response, 401, { code: 'unauthorized' });
      return;
    }
    if (url.pathname === '/api/v1/api-keys/current' && method === 'GET') {
      json(response, 200, { apiKey, permissions: this.permissions(apiKey), label: 'FiberPass fixture' });
      return;
    }
    if (url.pathname === '/api/v1/api-keys/current' && method === 'DELETE') {
      this.revokedKeys.add(apiKey);
      json(response, 200, {});
      return;
    }
    const invoiceCollection = '/api/v1/stores/' + this.storeId + '/invoices';
    if (url.pathname === invoiceCollection && method === 'POST') {
      const body = await readJson(request);
      const checkout = body.checkout as { paymentMethods?: unknown } | undefined;
      const metadata = body.metadata as { orderId?: unknown } | undefined;
      const rail = Array.isArray(checkout?.paymentMethods) && checkout.paymentMethods[0] === 'BTC-CHAIN' ? 'BTC-CHAIN' : 'BTC-LN';
      const amount = String(body.amount ?? '');
      const orderId = String(metadata?.orderId ?? '');
      this.invoiceCreateCalls += 1;
      this.invoiceCounter += 1;
      const id = 'provider-invoice-' + this.invoiceCounter;
      const paymentRequest = rail === 'BTC-LN'
        ? this.createOutgoingInvoice({ amountAtomic: btcToMsat(amount), preimage: this.invoiceCounter.toString(16).padStart(64, '0') }).invoice
        : 'bitcoin:' + this.receiveAddress + '?amount=' + amount;
      const invoice: FixtureInvoice = {
        id,
        storeId: this.storeId,
        amount,
        currency: 'BTC',
        status: 'New',
        checkoutLink: this.origin + 'i/' + id,
        expirationTime: Math.floor(Date.now() / 1000) + 900,
        metadata: { orderId },
        paymentMethods: [{ paymentMethodId: rail, destination: paymentRequest, paymentLink: paymentRequest, amount }]
      };
      this.invoices.set(id, invoice);
      if (this.dropNextInvoiceResponse) {
        this.dropNextInvoiceResponse = false;
        request.socket.destroy();
        return;
      }
      json(response, 200, invoice);
      return;
    }
    if (url.pathname === invoiceCollection && method === 'GET') {
      this.invoiceLookupCalls += 1;
      const orderIds = url.searchParams.getAll('orderId');
      json(response, 200, [...this.invoices.values()].filter((invoice) => orderIds.length === 0 || orderIds.includes(invoice.metadata.orderId)));
      return;
    }
    if (url.pathname.startsWith(invoiceCollection + '/') && method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice(invoiceCollection.length + 1));
      const invoice = this.invoices.get(id);
      json(response, invoice ? 200 : 404, invoice ?? { code: 'not_found' });
      return;
    }
    const lightningPayPath = '/api/v1/stores/' + this.storeId + '/lightning/BTC/invoices/pay';
    if (url.pathname === lightningPayPath && method === 'POST') {
      const body = await readJson(request);
      const invoice = String(body.BOLT11 ?? '').toLowerCase();
      const outgoing = this.outgoing.get(invoice);
      if (!outgoing) {
        json(response, 422, { code: 'unknown_invoice' });
        return;
      }
      this.lightningPayCalls += 1;
      this.paymentCounter += 1;
      const feeAmount = '1000';
      const payment: FixturePayment = {
        id: 'provider-payment-' + this.paymentCounter,
        status: 'Complete',
        paymentHash: outgoing.paymentHash,
        preimage: outgoing.preimage,
        totalAmount: (BigInt(outgoing.amountAtomic) + BigInt(feeAmount)).toString(10),
        feeAmount
      };
      this.payments.set(payment.paymentHash, payment);
      if (this.dropNextPaymentResponse) {
        this.dropNextPaymentResponse = false;
        request.socket.destroy();
        return;
      }
      json(response, 200, payment);
      return;
    }
    const paymentPrefix = '/api/v1/stores/' + this.storeId + '/lightning/BTC/payments/';
    if (url.pathname.startsWith(paymentPrefix) && method === 'GET') {
      this.paymentLookupCalls += 1;
      const payment = this.payments.get(url.pathname.slice(paymentPrefix.length).toLowerCase());
      json(response, payment ? 200 : 404, payment ?? { code: 'not_found' });
      return;
    }
    json(response, 404, { code: 'not_found' });
  }
}

function btcToMsat(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 100_000_000_000n + BigInt(fraction.padEnd(11, '0'))).toString(10);
}

export class MockBitcoinCoreServer {
  readonly rpcUsername = 'fiberpass';
  readonly rpcPassword = 'regtest-only';
  readonly fundingTxid = '11'.repeat(32);
  readonly fundingVout = 0;
  readonly fundingValueBtc = '0.00010000';
  readonly fundingAddress = payments.p2wpkh({ hash: Buffer.alloc(20, 3), network: networks.regtest }).address as string;
  readonly recipientAddress = payments.p2wpkh({ hash: Buffer.alloc(20, 4), network: networks.regtest }).address as string;
  readonly changeAddress = payments.p2wpkh({ hash: Buffer.alloc(20, 5), network: networks.regtest }).address as string;
  readonly rpcMethods: string[] = [];

  confirmations = 0;
  sendCalls = 0;
  sendAttempts = 0;
  rejectNextSend = false;
  inputSpent = false;
  private server?: Server;
  private rpcUrlValue = '';
  private readonly transactions = new Map<string, string>();

  get rpcUrl(): string {
    if (!this.rpcUrlValue) throw new Error('Mock Bitcoin Core server is not started.');
    return this.rpcUrlValue;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.rpcUrlValue = listeningUrl(this.server);
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request) as { id?: unknown; method?: unknown; params?: unknown };
    const id = String(body.id ?? '');
    const method = String(body.method ?? '');
    const params = Array.isArray(body.params) ? body.params : [];
    this.rpcMethods.push(method);
    try {
      const result = this.result(method, params);
      json(response, 200, { result, error: null, id });
    } catch (error) {
      json(response, 500, { result: null, error: { code: -5, message: error instanceof Error ? error.message : 'fixture error' }, id });
    }
  }

  private result(method: string, params: unknown[]): unknown {
    if (method === 'getblockchaininfo') return { chain: 'regtest', blocks: 101, headers: 101, initialblockdownload: false };
    if (method === 'gettxout') {
      if (this.inputSpent || params[0] !== this.fundingTxid || params[1] !== this.fundingVout) return null;
      const script = payments.p2wpkh({ address: this.fundingAddress, network: networks.regtest }).output as Uint8Array;
      return { bestblock: '22'.repeat(32), confirmations: 6, value: this.fundingValueBtc, scriptPubKey: { hex: Buffer.from(script).toString('hex'), type: 'witness_v0_keyhash', address: this.fundingAddress }, coinbase: false };
    }
    if (method === 'finalizepsbt') {
      const psbt = Psbt.fromBase64(String(params[0]), { network: networks.regtest });
      return { complete: true, hex: Buffer.from(psbt.data.globalMap.unsignedTx.toBuffer()).toString('hex') };
    }
    if (method === 'testmempoolaccept') {
      const hex = String((params[0] as unknown[])[0]);
      const txid = Transaction.fromHex(hex).getId();
      return [{ txid, allowed: true, vsize: Transaction.fromHex(hex).virtualSize(), fees: { base: 0.000001 } }];
    }
    if (method === 'sendrawtransaction') {
      this.sendAttempts += 1;
      if (this.rejectNextSend) {
        this.rejectNextSend = false;
        throw new Error('Simulated pre-acceptance broadcast failure');
      }
      const hex = String(params[0]);
      const txid = Transaction.fromHex(hex).getId();
      this.transactions.set(txid, hex);
      this.inputSpent = true;
      this.sendCalls += 1;
      return txid;
    }
    if (method === 'getrawtransaction') {
      const txid = String(params[0]);
      if (!this.transactions.has(txid)) throw new Error('No such mempool or blockchain transaction');
      return { txid, hash: txid, confirmations: this.confirmations, ...(this.confirmations > 0 ? { blockhash: '33'.repeat(32) } : {}) };
    }
    if (method === 'getmempoolentry') {
      const txid = String(params[0]);
      if (!this.transactions.has(txid) || this.confirmations > 0) throw new Error('Transaction not in mempool');
      return { vsize: 140, fees: { base: '0.000001' }, 'bip125-replaceable': true };
    }
    if (method === 'decoderawtransaction') return {};
    throw new Error('Unsupported fixture RPC method: ' + method);
  }
}
