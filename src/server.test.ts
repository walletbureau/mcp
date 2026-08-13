/**
 * A live round-trip over the MCP protocol: a real SDK client through an in-memory
 * transport. What the agent will see is what is tested — the tool list with the price
 * BEFORE any call (DoD 041 §5) and the response contents, including failures.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ApiClient, ApiResult, Pricing } from './api.ts';
import { loadConfig } from './config.ts';
import { createMcpServer, pricingSentence, type ServerDeps } from './server.ts';

const ADDRESS = '0x1111111111111111111111111111111111111111';

const PRICING: Pricing = {
  priceUsd: '0.05',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x2222222222222222222222222222222222222222',
};

const SCORE = {
  address: ADDRESS,
  score: 74,
  verdict: 'ok',
  flags: [{ code: 'activity_spike', severity: 'low', reason: 'Volume spike over the last 24 h' }],
};

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient & { scoreCalls: { address: string; demo: boolean }[] } {
  const scoreCalls: { address: string; demo: boolean }[] = [];
  return {
    scoreCalls,
    score: (address: string, demo: boolean): Promise<ApiResult<unknown>> => {
      scoreCalls.push({ address, demo });
      return Promise.resolve({ ok: true, data: SCORE, settlement: null });
    },
    stats: (): Promise<ApiResult<unknown>> =>
      Promise.resolve({ ok: true, data: { addresses_indexed: 12 }, settlement: null }),
    probePricing: (): Promise<Pricing | null> => Promise.resolve(PRICING),
    ...overrides,
  };
}

function deps(env: NodeJS.ProcessEnv, api: ApiClient, pricing: Pricing | null = PRICING): ServerDeps {
  return { config: loadConfig(env), api, pricing, payerAddress: null, version: '0.1.0' };
}

/** Starts the server plus a real MCP client connected to it. */
async function connect(serverDeps: ServerDeps): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(serverDeps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((item) => item.text ?? '').join('\n');
}

describe('MCP server: tool list', () => {
  it('serves exactly the two tools of the spec', async () => {
    const { client, close } = await connect(deps({}, fakeApi()));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['check_counterparty', 'get_service_stats']);
    await close();
  });

  it('the price is visible before any call — both in prose and machine-readable', async () => {
    const { client, close } = await connect(deps({ WALLETBUREAU_API_KEY: 'atk_test' }, fakeApi()));
    const tool = (await client.listTools()).tools.find((t) => t.name === 'check_counterparty');
    assert.ok(tool);
    assert.match(tool.description ?? '', /\$0\.05 per call/);
    assert.deepEqual(tool._meta?.['walletbureau/pricing'], {
      payment_mode: 'api_key',
      price_usd: '0.05',
      network: 'eip155:8453',
      asset: PRICING.asset,
      pay_to: PRICING.payTo,
      scheme: 'exact',
      protocol: 'x402',
    });
    await close();
  });

  it('the description from spec 041 §3 is not replaced', async () => {
    const { client, close } = await connect(deps({}, fakeApi()));
    const tool = (await client.listTools()).tools.find((t) => t.name === 'check_counterparty');
    assert.match(tool?.description ?? '', /^Before paying an unknown wallet on Base\/x402/);
    assert.match(tool?.description ?? '', /Not an accusation — risk signals with reasons\./);
    await close();
  });

  it('a price unavailable at startup is not invented', async () => {
    const { client, close } = await connect(deps({}, fakeApi(), null));
    const tool = (await client.listTools()).tools.find((t) => t.name === 'check_counterparty');
    assert.doesNotMatch(tool?.description ?? '', /\$0\.05/);
    assert.equal((tool?._meta?.['walletbureau/pricing'] as { price_usd: unknown }).price_usd, null);
    await close();
  });
});

describe('pricingSentence', () => {
  it('demo mode says outright that nothing is paid and how to enable payment', () => {
    const text = pricingSentence({ config: loadConfig({}), pricing: PRICING, payerAddress: null });
    assert.match(text, /free/);
    assert.match(text, /WALLETBUREAU_API_KEY/);
    assert.match(text, /X402_PRIVATE_KEY/);
  });

  it('wallet mode names the payer address and the spend cap', () => {
    const text = pricingSentence({
      config: loadConfig({ X402_PRIVATE_KEY: `0x${'a'.repeat(64)}`, X402_MAX_PRICE_USD: '0.2' }),
      pricing: PRICING,
      payerAddress: '0x3333333333333333333333333333333333333333',
    });
    assert.match(text, /0x3333333333333333333333333333333333333333/);
    assert.match(text, /spend cap per call: \$0\.2/);
  });
});

describe('MCP server: check_counterparty', () => {
  it('goes to the demo route without payment, and to the paid route with a key', async () => {
    const demoApi = fakeApi();
    const demo = await connect(deps({}, demoApi));
    await demo.client.callTool({ name: 'check_counterparty', arguments: { address: ADDRESS } });
    assert.deepEqual(demoApi.scoreCalls, [{ address: ADDRESS, demo: true }]);
    await demo.close();

    const paidApi = fakeApi();
    const paid = await connect(deps({ WALLETBUREAU_API_KEY: 'atk_test' }, paidApi));
    await paid.client.callTool({ name: 'check_counterparty', arguments: { address: ADDRESS } });
    assert.deepEqual(paidApi.scoreCalls, [{ address: ADDRESS, demo: false }]);
    await paid.close();
  });

  it('the response carries both the one-line summary and the full contract JSON', async () => {
    const { client, close } = await connect(deps({}, fakeApi()));
    const result = await client.callTool({ name: 'check_counterparty', arguments: { address: ADDRESS } });
    const text = textOf(result);
    assert.match(text, /score 74\/100, verdict "ok", 1 risk flag/);
    assert.deepEqual(JSON.parse(text.slice(text.indexOf('{'))), SCORE);
    assert.notEqual(result.isError, true);
    await close();
  });

  it('a garbage address is rejected locally — no quota and no money spent', async () => {
    const api = fakeApi();
    const { client, close } = await connect(deps({}, api));
    const result = await client.callTool({ name: 'check_counterparty', arguments: { address: 'not-an-address' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Expected 0x followed by 40 hexadecimal characters/);
    assert.equal(api.scoreCalls.length, 0);
    await close();
  });

  it('the address is normalized to lower case before the request', async () => {
    const api = fakeApi();
    const { client, close } = await connect(deps({}, api));
    await client.callTool({ name: 'check_counterparty', arguments: { address: ADDRESS.toUpperCase().replace('0X', '0x') } });
    assert.equal(api.scoreCalls[0]?.address, ADDRESS);
    await close();
  });

  it('an API failure reaches the model as a tool error, not a crash', async () => {
    const api = fakeApi({
      score: (): Promise<ApiResult<unknown>> => Promise.resolve({ ok: false, message: 'Top up the prepaid key.' }),
    });
    const { client, close } = await connect(deps({ WALLETBUREAU_API_KEY: 'atk_test' }, api));
    const result = await client.callTool({ name: 'check_counterparty', arguments: { address: ADDRESS } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Top up the prepaid key\./);
    await close();
  });

  it('the x402 settlement is shown to the user', async () => {
    const tx = `0x${'ab'.repeat(32)}`;
    const api = fakeApi({
      score: (): Promise<ApiResult<unknown>> =>
        Promise.resolve({ ok: true, data: SCORE, settlement: { transaction: tx } as never }),
    });
    const { client, close } = await connect(deps({ X402_PRIVATE_KEY: `0x${'a'.repeat(64)}` }, api));
    const result = await client.callTool({ name: 'check_counterparty', arguments: { address: ADDRESS } });
    assert.match(textOf(result), new RegExp(`settlement transaction: ${tx}`));
    await close();
  });
});

describe('MCP server: get_service_stats', () => {
  it('is free and returns the counters as-is', async () => {
    const { client, close } = await connect(deps({}, fakeApi()));
    const result = await client.callTool({ name: 'get_service_stats', arguments: {} });
    assert.deepEqual(JSON.parse(textOf(result)), { addresses_indexed: 12 });
    await close();
  });
});
