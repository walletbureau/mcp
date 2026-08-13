#!/usr/bin/env node
/**
 * Entry point of the local MCP server: stdio transport (specs/041-mcp.md §2, variant "b").
 * The process is launched by the user's MCP client (Claude Desktop, Claude Code, Cursor …),
 * so there is no server and no ports here — only stdin/stdout.
 */
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './api.ts';
import { loadConfig } from './config.ts';
import { logStderr } from './log.ts';
import { createPayer } from './payer.ts';
import { createMcpServer } from './server.ts';

/** The version comes from the package's package.json: one level up from dist and src alike. */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const payer = createPayer(config);
  const api = createApiClient({
    baseUrl: config.API_BASE_URL,
    timeoutMs: config.REQUEST_TIMEOUT_MS,
    paymentTimeoutMs: config.PAYMENT_TIMEOUT_MS,
    fetchImpl: payer.fetchImpl,
    rawFetchImpl: fetch,
    apiKey: config.WALLETBUREAU_API_KEY,
    paying: config.mode === 'wallet',
    maxPriceUsd: config.X402_MAX_PRICE_USD,
  });

  // The price is needed BEFORE the first call (DoD 041 §5), so we probe before connect:
  // the client sees it in the very first tools/list. If the service is down we still
  // start — just without the number.
  const pricing = await api.probePricing();
  if (!pricing) {
    logStderr(`could not read the price from ${config.API_BASE_URL}; tools will start without a price tag`);
  }

  const server = createMcpServer({ config, api, pricing, payerAddress: payer.payerAddress, version: readVersion() });
  await server.connect(new StdioServerTransport());
  logStderr(`ready: ${config.API_BASE_URL}, payment mode "${config.mode}"`);
}

main().catch((err: unknown) => {
  logStderr(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
