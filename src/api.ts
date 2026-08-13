/**
 * HTTP client for the public WalletBureau API (specs/040-api.md §3.1).
 *
 * There is no business logic here and there must not be any: the MCP server is a thin
 * wrapper over the API (041 §2), the score is computed by the service, and the response
 * schema is owned by 040 §3.2. This module's job is to make the HTTP call, stay within
 * the timeout, and turn a remote failure into text an LLM can act on (041 §4).
 *
 * The API response is passed through as-is (`unknown`): duplicating the 040 schema here
 * would create a second source of truth and break clients every time a field is added.
 */
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { SettleResponse } from '@x402/core/types';

/** Base address format — same as the API's (040 §3.2). Checked locally to save quota. */
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Address used for the free price probe: any syntactically valid address gets a 402 before
 * the API touches the database (validation in 040 runs before the payment middleware).
 */
const PRICE_PROBE_ADDRESS = '0x0000000000000000000000000000000000000000';

/** USDC on Base — 6 decimals. The price is only ever shown to a human or the model. */
const USDC_DECIMALS = 6;

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T; readonly settlement: SettleResponse | null }
  | { readonly ok: false; readonly message: string };

/** Price and payment details of the paid route, as announced by the API itself. */
export interface Pricing {
  readonly priceUsd: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly paymentTimeoutMs: number;
  /** fetch that already knows how to pay via x402 (wallet mode), or a plain one. */
  readonly fetchImpl: typeof globalThis.fetch;
  /** A guaranteed non-paying fetch — used for the price probe, or the wrapper would pay that 402. */
  readonly rawFetchImpl: typeof globalThis.fetch;
  /** Prepaid key; unset in the other modes. */
  readonly apiKey: string | undefined;
  /** In wallet mode a paid call gets a budget for signing and settlement. */
  readonly paying: boolean;
  /** Spending cap — only used for the error text when the payment policy rejects a price. */
  readonly maxPriceUsd: number;
}

export interface ApiClient {
  /** Score an address. `demo` — the free route with a daily quota (040 §3.1). */
  score: (address: string, demo: boolean) => Promise<ApiResult<unknown>>;
  stats: () => Promise<ApiResult<unknown>>;
  /** Price of the paid route straight from the API's 402 response; null if the service is down. */
  probePricing: () => Promise<Pricing | null>;
}

/** Atomic token units → a dollar string without trailing zeros: 50000 → "0.05". */
export function atomicToUsd(atomic: string, decimals = USDC_DECIMALS): string | null {
  if (!/^\d+$/.test(atomic)) return null;
  const base = 10n ** BigInt(decimals);
  const value = BigInt(atomic);
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${value / base}.${fraction}` : `${value / base}`;
}

interface ApiErrorBody {
  readonly error?: string;
  readonly message?: string;
}

function errorBodyOf(payload: unknown): ApiErrorBody {
  return payload !== null && typeof payload === 'object' ? (payload as ApiErrorBody) : {};
}

/**
 * API failure → text from which the model understands what to do next (041 §4).
 * The service's own message is kept verbatim and a hint about our environment is appended:
 * the first explains "what happened", the second — "what to fix".
 */
function describeFailure(status: number, payload: unknown): string {
  const body = errorBodyOf(payload);
  const said = body.message ?? `HTTP ${status}`;
  switch (body.error ?? '') {
    case 'invalid_address':
      return `Invalid address. ${said}`;
    case 'invalid_api_key':
    case 'key_disabled':
      return `${said} Check the WALLETBUREAU_API_KEY environment variable of this MCP server.`;
    case 'insufficient_balance':
      return `${said} Top up the prepaid key, or set X402_PRIVATE_KEY to pay per call with x402 instead.`;
    case 'payment_required':
      return (
        `${said} This MCP server has no payment credentials configured: set WALLETBUREAU_API_KEY ` +
        'for a prepaid key, or X402_PRIVATE_KEY to pay per call from a wallet.'
      );
    case 'demo_limit_reached':
      return (
        `${said} This MCP server is running on the free demo quota. Set WALLETBUREAU_API_KEY or ` +
        'X402_PRIVATE_KEY to keep checking addresses today.'
      );
    case 'rate_limited':
      return `${said} Wait a second and retry.`;
    case 'score_unavailable':
    case 'db_unavailable':
    case 'internal_error':
      return `${said} This is a temporary problem on the service side, not a problem with the address — retry shortly.`;
    default:
      return status >= 500
        ? `The service returned HTTP ${status}: ${said} Retry shortly.`
        : `The service rejected the request with HTTP ${status}: ${said}`;
  }
}

/**
 * A failure of the paying wrapper is not "network is down", and the two must not be
 * confused: the user would go fix the wrong thing. Our own spending cap fires most
 * often, so it is named first.
 */
function describePaymentError(err: unknown, maxPriceUsd: number): string | null {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail.includes('filtered out by policies')) {
    return (
      `The service asks for more than this server is allowed to pay for one call ($${maxPriceUsd}). ` +
      'Raise X402_MAX_PRICE_USD if that price is acceptable, or switch to a prepaid API key.'
    );
  }
  if (/payment/i.test(detail)) {
    return `Could not pay for this call: ${detail}. Check that the payer wallet holds enough USDC on Base.`;
  }
  return null;
}

/** Network failure/timeout — also in plain words, no stack traces in the model's answer. */
function describeTransportError(err: unknown, timeoutMs: number): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `The service did not answer within ${timeoutMs} ms. Retry shortly.`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `Could not reach the service: ${detail}. Check API_BASE_URL and the network connection.`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

/** The x402 settlement arrives in a header; useful for display, irrelevant for logic. */
function settlementOf(response: Response): SettleResponse | null {
  const header = response.headers.get('payment-response') ?? response.headers.get('x-payment-response');
  if (!header) return null;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return null;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl, fetchImpl, apiKey } = options;

  const request = async (path: string, timeoutMs: number): Promise<ApiResult<unknown>> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const payment = options.paying ? describePaymentError(err, options.maxPriceUsd) : null;
      return { ok: false, message: payment ?? describeTransportError(err, timeoutMs) };
    }
    const payload = await readJson(response);
    if (!response.ok) return { ok: false, message: describeFailure(response.status, payload) };
    return { ok: true, data: payload, settlement: settlementOf(response) };
  };

  return {
    score: (address, demo) =>
      request(
        demo ? `/v1/demo/score/${address}` : `/v1/score/${address}`,
        demo || !options.paying ? options.timeoutMs : options.paymentTimeoutMs,
      ),

    stats: () => request('/v1/stats', options.timeoutMs),

    /**
     * The price is pulled from the API rather than hardcoded in a second place (041 §3):
     * an unpaid request legitimately answers 402 and puts the requirements into the
     * PAYMENT-REQUIRED header. The request is free and never reaches the database. We go
     * with the raw fetch — the paying wrapper would have paid that 402.
     */
    probePricing: async (): Promise<Pricing | null> => {
      try {
        const response = await options.rawFetchImpl(`${baseUrl}/v1/score/${PRICE_PROBE_ADDRESS}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        await response.text();
        if (response.status !== 402) return null;
        const header = response.headers.get('payment-required');
        if (!header) return null;
        const requirements = decodePaymentRequiredHeader(header).accepts[0];
        if (!requirements) return null;
        const priceUsd = atomicToUsd(requirements.amount);
        if (priceUsd === null) return null;
        return {
          priceUsd,
          network: requirements.network,
          asset: requirements.asset,
          payTo: requirements.payTo,
        };
      } catch {
        return null;
      }
    },
  };
}
