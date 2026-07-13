import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { isFiberCkbAddress, FIBER_CKB_ADDRESS_ERROR } from '../lib/fiberAddress.js';
import { executeFiberExitSettlement, getFiberExitSettlementReadiness, type VaultPayoutResult } from './vaultPayout.service.js';

export interface FiberExitInvoiceInput {
  amountMinor: number;
  currency: string;
  recipientAddress: string;
  description: string;
}

export interface FiberExitInvoiceResult {
  invoice: string;
  invoiceHash: string;
  raw?: unknown;
}

export interface FiberExitSettlementInput {
  recipientAddress: string;
  amountMinor: number;
  currency: string;
}

type RpcInvoiceResult = {
  invoice_address?: unknown;
  invoiceAddress?: unknown;
  invoice?: unknown;
};

function fiberCurrency(currency: string): 'Fibb' | 'Fibt' | 'Fibd' {
  if (currency.toUpperCase() !== 'CKB') {
    throw new ApiError(400, 'FIBER_EXIT_UNSUPPORTED_CURRENCY', 'Fiber exit gateway currently supports CKB payouts only.');
  }
  const network = env.FIBER_NETWORK.toLowerCase();
  if (network.includes('main')) return 'Fibb';
  if (network.includes('dev')) return 'Fibd';
  return 'Fibt';
}

function invoiceHash(invoice: string): string {
  return createHash('sha256').update(invoice).digest('hex');
}

async function callFiberRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(env.FIBER_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.FIBER_API_KEY ? { Authorization: 'Bearer ' + env.FIBER_API_KEY } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });

  const payload = await response.json().catch(() => null) as { result?: unknown; error?: { code?: number; message?: string } } | null;
  if (!response.ok || payload?.error) {
    throw new ApiError(502, 'FIBER_EXIT_RPC_FAILED', payload?.error?.message ?? 'Fiber exit RPC request failed: ' + method, payload?.error);
  }
  return payload?.result;
}

export async function createFiberExitInvoice(input: FiberExitInvoiceInput): Promise<FiberExitInvoiceResult> {
  if (!isFiberCkbAddress(input.recipientAddress)) {
    throw new ApiError(400, 'INVALID_RECIPIENT_ADDRESS', FIBER_CKB_ADDRESS_ERROR);
  }
  if (input.amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_FIBER_EXIT_AMOUNT', 'Fiber exit invoice amount must be greater than zero.');
  }

  const raw = await callFiberRpc('new_invoice', [{
    amount: String(input.amountMinor),
    description: input.description.slice(0, 240),
    currency: fiberCurrency(input.currency),
    fallback_address: input.recipientAddress,
    expiry: env.FIBER_EXIT_INVOICE_EXPIRY_SECONDS,
    allow_mpp: true
  }]);
  const record = raw && typeof raw === 'object' ? raw as RpcInvoiceResult : {};
  const invoice = typeof record.invoice_address === 'string'
    ? record.invoice_address
    : typeof record.invoiceAddress === 'string'
      ? record.invoiceAddress
      : '';
  if (!invoice) {
    throw new ApiError(502, 'FIBER_EXIT_INVOICE_CREATE_FAILED', 'Fiber node did not return an exit invoice address.');
  }

  return { invoice, invoiceHash: invoiceHash(invoice), raw };
}

export async function executeFiberExitCkbSettlement(input: FiberExitSettlementInput): Promise<VaultPayoutResult> {
  const readiness = getFiberExitSettlementReadiness();
  if (!readiness.ready) {
    throw new ApiError(503, readiness.code ?? 'FIBER_EXIT_SETTLEMENT_NOT_READY', readiness.message ?? 'Fiber exit settlement is not configured.');
  }
  return executeFiberExitSettlement({
    recipientAddress: input.recipientAddress,
    amountMinor: input.amountMinor,
    currency: input.currency
  });
}
