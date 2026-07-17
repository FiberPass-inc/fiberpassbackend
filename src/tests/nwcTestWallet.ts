import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import * as bolt11 from 'bolt11';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from 'nostr-tools/nip04';
import { v2 as nip44 } from 'nostr-tools/nip44';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { NWC_INFO_KIND, NWC_REQUEST_KIND, NWC_RESPONSE_KIND, type NwcNetwork } from '../domain/nwc.js';

const BOLT11_NETWORKS: Record<NwcNetwork, {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
  validWitnessVersions: number[];
}> = {
  mainnet: { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, validWitnessVersions: [0, 1] },
  testnet: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  signet: { bech32: 'tbs', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  regtest: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] }
};

interface MockTransaction {
  paymentHash: string;
  preimage: string;
  amount: string;
  invoice: string;
  state: 'settled';
  feesPaid: string;
}

interface Subscription {
  id: string;
  filter: Record<string, unknown>;
}

export interface MockNwcWalletOptions {
  network?: NwcNetwork;
  methods?: string[];
  balance?: string;
  budget?: { total: string; used?: string; enforced?: boolean; resetsAt?: number };
}

function rawText(data: RawData): string {
  return typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
}

function matches(event: Event, filter: Record<string, unknown>): boolean {
  const kinds = Array.isArray(filter.kinds) ? filter.kinds : undefined;
  const authors = Array.isArray(filter.authors) ? filter.authors : undefined;
  const since = typeof filter.since === 'number' ? filter.since : undefined;
  if (kinds && !kinds.includes(event.kind)) return false;
  if (authors && !authors.includes(event.pubkey)) return false;
  if (since != null && event.created_at < since) return false;
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(value)) continue;
    const tagName = key.slice(1);
    if (!event.tags.some((tag) => tag[0] === tagName && value.includes(tag[1]))) return false;
  }
  return true;
}

function requestEncryption(event: Event): 'nip44_v2' | 'nip04' {
  return event.tags.find((tag) => tag[0] === 'encryption')?.[1] === 'nip44_v2' ? 'nip44_v2' : 'nip04';
}

export class MockNwcRelayWallet {
  readonly walletSecret = generateSecretKey();
  readonly walletPubkey = getPublicKey(this.walletSecret);
  readonly methods: string[];
  readonly network: NwcNetwork;
  readonly balance: string;
  budget?: MockNwcWalletOptions['budget'];
  payInvoiceCalls = 0;
  lookupInvoiceCalls = 0;
  timeoutNextPay = false;
  payResponseDelayMs = 0;

  private server?: WebSocketServer;
  private relayUrlValue = '';
  private readonly events: Event[] = [];
  private readonly subscriptions = new Map<WebSocket, Subscription[]>();
  private readonly invoices = new Map<string, MockTransaction>();
  private readonly transactions = new Map<string, MockTransaction>();

  constructor(options: MockNwcWalletOptions = {}) {
    this.network = options.network ?? 'regtest';
    this.methods = options.methods ?? ['get_info', 'get_balance', 'pay_invoice', 'lookup_invoice', 'list_transactions'];
    this.balance = options.balance ?? '250000000';
    this.budget = options.budget;
  }

  get relayUrl(): string {
    if (!this.relayUrlValue) throw new Error('Mock relay is not started.');
    return this.relayUrlValue;
  }

  async start(): Promise<void> {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => this.server?.once('listening', () => resolve()));
    const address = this.server.address() as AddressInfo;
    this.relayUrlValue = 'ws://127.0.0.1:' + address.port + '/';
    this.events.push(finalizeEvent({
      kind: NWC_INFO_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['encryption', 'nip44_v2 nip04'], ['notifications', 'payment_sent']],
      content: this.methods.join(' ')
    }, this.walletSecret));
    this.server.on('connection', (socket) => {
      this.subscriptions.set(socket, []);
      socket.on('message', (data) => void this.onMessage(socket, data));
      socket.on('close', () => this.subscriptions.delete(socket));
    });
  }

  connectionUri(clientSecret: Uint8Array): string {
    const query = new URLSearchParams({ relay: this.relayUrl, secret: Buffer.from(clientSecret).toString('hex') });
    return 'nostr+walletconnect://' + this.walletPubkey + '?' + query.toString();
  }

  createInvoice(input: { preimage: string; amount: string; expirySeconds?: number }): { invoice: string; paymentHash: string } {
    const paymentHash = createHash('sha256').update(Buffer.from(input.preimage, 'hex')).digest('hex');
    const encoded = bolt11.encode({
      network: BOLT11_NETWORKS[this.network],
      millisatoshis: input.amount,
      timestamp: Math.floor(Date.now() / 1000),
      tags: [
        { tagName: 'payment_hash', data: paymentHash },
        { tagName: 'description', data: 'FiberPass NWC test payment' },
        { tagName: 'expire_time', data: input.expirySeconds ?? 3600 }
      ]
    });
    const invoice = bolt11.sign(encoded, Buffer.alloc(32, 7)).paymentRequest;
    if (!invoice) throw new Error('BOLT11 test invoice was not signed.');
    this.invoices.set(invoice, {
      paymentHash,
      preimage: input.preimage,
      amount: input.amount,
      invoice,
      state: 'settled',
      feesPaid: '10'
    });
    return { invoice, paymentHash };
  }

  private async onMessage(socket: WebSocket, data: RawData): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(rawText(data));
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    if (message[0] === 'REQ' && typeof message[1] === 'string') {
      const filter = message[2] && typeof message[2] === 'object' ? message[2] as Record<string, unknown> : {};
      const subscriptions = this.subscriptions.get(socket) ?? [];
      subscriptions.push({ id: message[1], filter });
      this.subscriptions.set(socket, subscriptions);
      for (const event of this.events.filter((candidate) => matches(candidate, filter))) {
        socket.send(JSON.stringify(['EVENT', message[1], event]));
      }
      socket.send(JSON.stringify(['EOSE', message[1]]));
      return;
    }
    if (message[0] === 'CLOSE' && typeof message[1] === 'string') {
      this.subscriptions.set(socket, (this.subscriptions.get(socket) ?? []).filter((item) => item.id !== message[1]));
      return;
    }
    if (message[0] !== 'EVENT') return;
    const event = message[1] as Event;
    if (!event || !verifyEvent(event)) return;
    this.events.push(event);
    socket.send(JSON.stringify(['OK', event.id, true, '']));
    this.broadcast(event);
    if (event.kind === NWC_REQUEST_KIND && event.tags.some((tag) => tag[0] === 'p' && tag[1] === this.walletPubkey)) {
      await this.handleWalletRequest(event);
    }
  }

  private broadcast(event: Event): void {
    for (const [socket, subscriptions] of this.subscriptions) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      for (const subscription of subscriptions) {
        if (matches(event, subscription.filter)) socket.send(JSON.stringify(['EVENT', subscription.id, event]));
      }
    }
  }

  private async handleWalletRequest(event: Event): Promise<void> {
    const encryption = requestEncryption(event);
    const plaintext = encryption === 'nip44_v2'
      ? nip44.decrypt(event.content, nip44.utils.getConversationKey(this.walletSecret, event.pubkey))
      : await nip04Decrypt(this.walletSecret, event.pubkey, event.content);
    const request = JSON.parse(plaintext) as { method: string; params?: Record<string, unknown> };
    let result: Record<string, unknown> | null = null;
    let error: { code: string; message: string } | null = null;

    if (!this.methods.includes(request.method)) {
      error = { code: 'NOT_IMPLEMENTED', message: 'Method not enabled.' };
    } else if (request.method === 'get_info') {
      result = {
        alias: 'FiberPass test NWC wallet',
        pubkey: this.walletPubkey,
        network: this.network,
        methods: this.methods,
        notifications: ['payment_sent'],
        ...(this.budget ? {
          budget: {
            enforced: this.budget.enforced ?? true,
            unit: 'msat',
            total_budget: this.budget.total,
            used_budget: this.budget.used ?? '0',
            renews_at: this.budget.resetsAt
          }
        } : {})
      };
    } else if (request.method === 'get_balance') {
      result = { balance: this.balance };
    } else if (request.method === 'pay_invoice') {
      this.payInvoiceCalls += 1;
      const invoice = typeof request.params?.invoice === 'string' ? request.params.invoice.toLowerCase() : '';
      const payment = this.invoices.get(invoice);
      if (!payment) {
        error = { code: 'PAYMENT_FAILED', message: 'Unknown test invoice.' };
      } else {
        this.transactions.set(payment.paymentHash, payment);
        result = { preimage: payment.preimage, fees_paid: payment.feesPaid };
        if (this.timeoutNextPay) {
          this.timeoutNextPay = false;
          return;
        }
        if (this.payResponseDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.payResponseDelayMs));
        }
      }
    } else if (request.method === 'lookup_invoice') {
      this.lookupInvoiceCalls += 1;
      const paymentHash = typeof request.params?.payment_hash === 'string' ? request.params.payment_hash.toLowerCase() : '';
      const payment = this.transactions.get(paymentHash);
      if (!payment) error = { code: 'NOT_FOUND', message: 'Payment not found.' };
      else result = {
        type: 'outgoing',
        state: payment.state,
        invoice: payment.invoice,
        preimage: payment.preimage,
        payment_hash: payment.paymentHash,
        amount: payment.amount,
        fees_paid: payment.feesPaid,
        created_at: Math.floor(Date.now() / 1000),
        settled_at: Math.floor(Date.now() / 1000)
      };
    } else if (request.method === 'list_transactions') {
      result = { transactions: [...this.transactions.values()].map((payment) => ({
        type: 'outgoing',
        state: payment.state,
        payment_hash: payment.paymentHash,
        amount: payment.amount,
        fees_paid: payment.feesPaid
      })) };
    }

    const responseText = JSON.stringify({ result_type: request.method, error, result });
    const content = encryption === 'nip44_v2'
      ? nip44.encrypt(responseText, nip44.utils.getConversationKey(this.walletSecret, event.pubkey))
      : await nip04Encrypt(this.walletSecret, event.pubkey, responseText);
    const response = finalizeEvent({
      kind: NWC_RESPONSE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', event.pubkey], ['e', event.id], ['encryption', encryption]],
      content
    }, this.walletSecret);
    this.events.push(response);
    this.broadcast(response);
  }

  async close(): Promise<void> {
    for (const socket of this.subscriptions.keys()) socket.terminate();
    this.subscriptions.clear();
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
    this.server = undefined;
  }
}
