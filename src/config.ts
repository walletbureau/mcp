/**
 * Configuration of the MCP server (specs/041-mcp.md §3). Environment only: the server is
 * launched by the user's MCP client, we have no config files of our own.
 *
 * Three payment modes, chosen by what is present in the environment:
 *   wallet   — X402_PRIVATE_KEY is set: the package signs an x402 payment for every call;
 *   api_key  — WALLETBUREAU_API_KEY is set: calls draw down the key's prepaid balance;
 *   demo     — nothing is set: the API's free demo quota is used (040 §3.1, 3/day per IP).
 *
 * The demo mode is a deliberate decision: installation must be a one-liner (041 §5) and the
 * first call must work without any setup. After that the user chooses whether to pay with
 * a key or a wallet.
 */
import { z } from 'zod';

export type PaymentMode = 'demo' | 'api_key' | 'wallet';

/** API key (040 §3.1): the `Authorization: Bearer atk_…` header. */
const apiKey = z.string().regex(/^atk_[\w-]+$/, 'expected an API key of the form atk_…');

/** Payer's private key — 32 bytes hex. Never logged anywhere. */
const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'expected a private key: 0x followed by 64 hex characters');

const ConfigSchema = z.object({
  API_BASE_URL: z
    .url('expected an absolute URL, e.g. https://walletbureau.com')
    .default('https://walletbureau.com')
    .transform((url) => url.replace(/\/+$/, '')),
  WALLETBUREAU_API_KEY: apiKey.optional(),
  X402_PRIVATE_KEY: privateKey.optional(),
  /**
   * Spending cap per call. The official x402 guidance requires the amount check to live
   * next to the payment client rather than rely on the model's prompt: the server names
   * its own price, and without a cap a compromised or spoofed host could ask for anything.
   */
  X402_MAX_PRICE_USD: z.coerce.number().positive().default(0.1),
  /** Timeout of a regular API call (041 §4). */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /**
   * Separate budget for a paid call: it covers signing the payment and the facilitator's
   * settle (x402 allows 60 s for that by default). Such a call does not fit into the 5 s
   * of 041 §4 — that is not the network being slow, that is on-chain settlement.
   */
  PAYMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});

export type McpConfig = z.infer<typeof ConfigSchema> & { readonly mode: PaymentMode };

/** A blank environment variable means "not set", not "set to empty". */
function withoutBlanks(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const parsed = ConfigSchema.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration of the WalletBureau MCP server:\n${issues}`);
  }
  // The key wins over the wallet when both are set: the balance is already paid for, while
  // an x402 payment is one more on-chain transaction. Same order as the API itself (040 §4).
  const mode: PaymentMode = parsed.data.WALLETBUREAU_API_KEY
    ? 'api_key'
    : parsed.data.X402_PRIVATE_KEY
      ? 'wallet'
      : 'demo';
  return { ...parsed.data, mode };
}
