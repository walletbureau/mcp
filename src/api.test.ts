/**
 * API client: routes per payment mode, turning failures into text for the LLM (041 §4)
 * and probing the price off a live 402 (041 §3). The network is stubbed — we test our
 * parsing, not someone else's HTTP.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, SettleResponse } from '@x402/core/types';
import { atomicToUsd, createApiClient, type ApiClientOptions } from './api.ts';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const BASE = 'https://walletbureau.com';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** fetch stub: records calls and returns a pre-arranged response. */
function stubFetch(reply: Response | (() => never)): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const headers = init?.headers;
    calls.push({
      url: String(input),
      headers: headers && !Array.isArray(headers) && !(headers instanceof Headers)
        ? (headers as Record<string, string>)
        : {},
    });
    if (typeof reply !== 'function') return Promise.resolve(reply.clone());
    try {
      reply();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.reject(new Error('the stub was supposed to throw'));
  };
  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

function client(reply: Response | (() => never), overrides: Partial<ApiClientOptions> = {}): {
  api: ReturnType<typeof createApiClient>;
  calls: Call[];
} {
  const stub = stubFetch(reply);
  const api = createApiClient({
    baseUrl: BASE,
    timeoutMs: 5_000,
    paymentTimeoutMs: 60_000,
    fetchImpl: stub.fetch,
    rawFetchImpl: stub.fetch,
    apiKey: undefined,
    paying: false,
    maxPriceUsd: 0.1,
    ...overrides,
  });
  return { api, calls: stub.calls };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('atomicToUsd', () => {
  it('converts atomic USDC into dollars without trailing zeros', () => {
    assert.equal(atomicToUsd('50000'), '0.05');
    assert.equal(atomicToUsd('1000000'), '1');
    assert.equal(atomicToUsd('1'), '0.000001');
    assert.equal(atomicToUsd('0'), '0');
  });

  it('does not invent a price from a non-decimal amount', () => {
    assert.equal(atomicToUsd('0x50000'), null);
    assert.equal(atomicToUsd(''), null);
  });
});

describe('ApiClient.score', () => {
  it('takes the free route in demo mode', async () => {
    const { api, calls } = client(jsonResponse(200, { score: 74 }));
    const result = await api.score(ADDRESS, true);
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, `${BASE}/v1/demo/score/${ADDRESS}`);
  });

  it('takes the paid route with a key and carries Authorization', async () => {
    const { api, calls } = client(jsonResponse(200, { score: 74 }), { apiKey: 'atk_test' });
    await api.score(ADDRESS, false);
    assert.equal(calls[0]?.url, `${BASE}/v1/score/${ADDRESS}`);
    assert.equal(calls[0]?.headers['authorization'], 'Bearer atk_test');
  });

  it('parses the x402 settlement header and delivers it to the caller', async () => {
    const settlement: SettleResponse = {
      success: true,
      transaction: `0x${'ab'.repeat(32)}`,
      network: 'eip155:8453',
      payer: ADDRESS,
    } as SettleResponse;
    const { api } = client(
      jsonResponse(200, { score: 74 }, { 'payment-response': encodePaymentResponseHeader(settlement) }),
    );
    const result = await api.score(ADDRESS, false);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.settlement?.transaction, settlement.transaction);
  });

  it('a broken settlement header does not fail a successful response', async () => {
    const { api } = client(jsonResponse(200, { score: 74 }, { 'payment-response': 'not-base64-json' }));
    const result = await api.score(ADDRESS, false);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.settlement, null);
  });
});

describe('ApiClient: turning API failures into text for the model', () => {
  const cases: { status: number; body: { error: string; message: string }; expect: RegExp }[] = [
    {
      status: 400,
      body: { error: 'invalid_address', message: 'Expected an address: 0x followed by 40 hex characters.' },
      expect: /Invalid address\./,
    },
    {
      status: 401,
      body: { error: 'invalid_api_key', message: 'API key not recognized.' },
      expect: /WALLETBUREAU_API_KEY/,
    },
    {
      status: 402,
      body: { error: 'insufficient_balance', message: 'Key balance $0.00.' },
      expect: /X402_PRIVATE_KEY/,
    },
    {
      status: 402,
      body: { error: 'payment_required', message: 'A score costs $0.05.' },
      expect: /WALLETBUREAU_API_KEY.*X402_PRIVATE_KEY/s,
    },
    {
      status: 429,
      body: { error: 'demo_limit_reached', message: 'Free checks per day: 3.' },
      expect: /free demo quota/,
    },
    { status: 429, body: { error: 'rate_limited', message: 'Too many requests.' }, expect: /Wait a second/ },
    {
      status: 503,
      body: { error: 'score_unavailable', message: 'Scoring is temporarily unavailable.' },
      expect: /temporary problem on the service side/,
    },
  ];

  for (const { status, body, expect } of cases) {
    it(`${status} ${body.error} explains what to do`, async () => {
      const { api } = client(jsonResponse(status, body));
      const result = await api.score(ADDRESS, false);
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.message, expect);
      // The service's own text is preserved: the model must see both the cause and the hint.
      assert.ok(!result.ok && result.message.includes(body.message));
    });
  }

  it('an unknown error code does not stay silent', async () => {
    const { api } = client(jsonResponse(418, { error: 'teapot', message: 'nope' }));
    const result = await api.score(ADDRESS, false);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /HTTP 418/);
  });

  it('a non-JSON response does not crash the client', async () => {
    const { api } = client(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const result = await api.score(ADDRESS, false);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /HTTP 502/);
  });

  it('a timeout becomes a clear request to retry', async () => {
    const { api } = client(() => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    });
    const result = await api.score(ADDRESS, false);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /did not answer within 5000 ms/);
  });

  it('a triggered spend cap is not presented as a network failure — the network is not what to fix', async () => {
    const { api } = client(
      () => {
        throw new Error(
          'Failed to create payment payload: All payment requirements were filtered out by policies for x402 version: 2',
        );
      },
      { paying: true, maxPriceUsd: 0.03 },
    );
    const result = await api.score(ADDRESS, false);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /allowed to pay for one call \(\$0\.03\)/);
    assert.match(result.ok ? '' : result.message, /X402_MAX_PRICE_USD/);
    assert.doesNotMatch(result.ok ? '' : result.message, /network connection/);
  });

  it('another payment failure suggests checking the wallet balance, not the URL', async () => {
    const { api } = client(() => {
      throw new Error('Failed to create payment payload: insufficient funds');
    }, { paying: true });
    const result = await api.score(ADDRESS, false);
    assert.match(result.ok ? '' : result.message, /holds enough USDC on Base/);
  });

  it('when no wallet pays, "payment" in the error text is irrelevant — it is a network failure', async () => {
    const { api } = client(() => {
      throw new TypeError('fetch failed while sending payment headers');
    });
    const result = await api.score(ADDRESS, false);
    assert.match(result.ok ? '' : result.message, /Could not reach the service/);
  });

  it('an unreachable network names the variable to check', async () => {
    const { api } = client(() => {
      throw new TypeError('fetch failed');
    });
    const result = await api.score(ADDRESS, false);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /API_BASE_URL/);
  });
});

describe('ApiClient.probePricing', () => {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: `${BASE}/v1/score/{address}` },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '50000',
        payTo: '0x2222222222222222222222222222222222222222',
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  } as PaymentRequired;

  it('reads the price off a real 402 — there is no second place in the code with a price', async () => {
    const { api, calls } = client(
      jsonResponse(402, { error: 'payment_required' }, {
        'payment-required': encodePaymentRequiredHeader(paymentRequired),
      }),
    );
    const pricing = await api.probePricing();
    assert.deepEqual(pricing, {
      priceUsd: '0.05',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x2222222222222222222222222222222222222222',
    });
    // The probe must be free: the paid route, but with no payment and no key.
    assert.match(calls[0]?.url ?? '', /\/v1\/score\/0x0{40}$/);
    assert.equal(calls[0]?.headers['authorization'], undefined);
  });

  it('does not invent a price without the requirements header', async () => {
    const { api } = client(jsonResponse(402, { error: 'payment_required' }));
    assert.equal(await api.probePricing(), null);
  });

  it('an unreachable service does not block server startup', async () => {
    const { api } = client(() => {
      throw new TypeError('fetch failed');
    });
    assert.equal(await api.probePricing(), null);
  });
});
