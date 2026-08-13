/**
 * MCP tools (specs/041-mcp.md §3, §4): `check_counterparty` — paid, `get_service_stats` —
 * free. No further free lures beyond these (041 §6).
 *
 * The description of `check_counterparty` is read by the client's LLM, so its text is taken
 * from the spec verbatim, and the price is appended as a separate sentence — it is only
 * known at runtime, the API provides it. There is deliberately no cache here (041 §4):
 * the service caches, a local copy would drift from it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ADDRESS_RE, type ApiClient, type Pricing } from './api.ts';
import type { McpConfig } from './config.ts';

/** 041 §3 — the text the model uses to decide whether to call the tool. Change only together with the spec. */
const CHECK_DESCRIPTION =
  'Before paying an unknown wallet on Base/x402, check its behavioral risk score. Returns 0–100 ' +
  'score, verdict (ok/caution/avoid) and explained risk flags based on the full history of ' +
  'x402/EIP-3009 USDC transfers. Not an accusation — risk signals with reasons.';

export interface ServerDeps {
  readonly config: McpConfig;
  readonly api: ApiClient;
  /** Price probed from the API at startup; null — the service did not answer, no price shown. */
  readonly pricing: Pricing | null;
  readonly payerAddress: string | null;
  readonly version: string;
}

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/** The price-and-payment sentence — what the client sees before calling (DoD 041 §5). */
export function pricingSentence(deps: Pick<ServerDeps, 'config' | 'pricing' | 'payerAddress'>): string {
  const price = deps.pricing ? `$${deps.pricing.priceUsd}` : 'a fee published by the service';
  switch (deps.config.mode) {
    case 'wallet':
      return (
        `Cost: ${price} per call, paid automatically in USDC` +
        (deps.pricing ? ` on ${deps.pricing.network}` : '') +
        (deps.payerAddress ? ` from wallet ${deps.payerAddress}` : '') +
        ` (spend cap per call: $${deps.config.X402_MAX_PRICE_USD}).`
      );
    case 'api_key':
      return `Cost: ${price} per call, debited from the prepaid API key configured in this server.`;
    case 'demo':
      return (
        'Cost: free — this server has no payment credentials, so it uses the public demo quota ' +
        `(a few checks per day per IP). Paid mode costs ${price} per call: set WALLETBUREAU_API_KEY ` +
        'for a prepaid key or X402_PRIVATE_KEY to pay from a wallet.'
      );
  }
}

interface ScoreShape {
  readonly score?: unknown;
  readonly verdict?: unknown;
  readonly flags?: unknown;
}

/** One-line summary before the JSON: the model must not parse a document to see the verdict. */
function summaryLine(address: string, data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const { score, verdict, flags } = data as ScoreShape;
  if (typeof score !== 'number' || typeof verdict !== 'string') return null;
  const flagCount = Array.isArray(flags) ? flags.length : 0;
  return `${address}: score ${score}/100, verdict "${verdict}", ${flagCount} risk flag(s).`;
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const { api, config } = deps;
  const server = new McpServer({ name: 'walletbureau', version: deps.version });

  server.registerTool(
    'check_counterparty',
    {
      title: 'Check counterparty wallet risk',
      description: `${CHECK_DESCRIPTION} ${pricingSentence(deps)}`,
      inputSchema: {
        address: z
          .string()
          .describe('Wallet address on Base to check: 0x followed by 40 hexadecimal characters.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      // The price machine-readable, not only in prose: the MCP inspector and catalogs show it before the call.
      _meta: {
        'walletbureau/pricing': {
          payment_mode: config.mode,
          price_usd: deps.pricing?.priceUsd ?? null,
          network: deps.pricing?.network ?? null,
          asset: deps.pricing?.asset ?? null,
          pay_to: deps.pricing?.payTo ?? null,
          scheme: 'exact',
          protocol: 'x402',
        },
      },
    },
    async ({ address }): Promise<CallToolResult> => {
      // The format is checked locally: a garbage address must not burn a payment or demo quota.
      if (!ADDRESS_RE.test(address)) {
        return textResult(
          `Invalid address "${address}". Expected 0x followed by 40 hexadecimal characters. ` +
            'Ask the user for the exact wallet address.',
          true,
        );
      }
      const result = await api.score(address.toLowerCase(), config.mode === 'demo');
      if (!result.ok) return textResult(result.message, true);

      const lines: string[] = [];
      const summary = summaryLine(address.toLowerCase(), result.data);
      if (summary) lines.push(summary);
      lines.push(JSON.stringify(result.data, null, 2));
      if (result.settlement?.transaction) {
        lines.push(`Paid via x402, settlement transaction: ${result.settlement.transaction}`);
      }
      return textResult(lines.join('\n\n'));
    },
  );

  server.registerTool(
    'get_service_stats',
    {
      title: 'WalletBureau service stats',
      description:
        'Public counters of the WalletBureau index: addresses indexed, USDC transfers ingested and ' +
        'scores served. Free, no payment required.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (): Promise<CallToolResult> => {
      const result = await api.stats();
      return result.ok ? textResult(JSON.stringify(result.data, null, 2)) : textResult(result.message, true);
    },
  );

  return server;
}
