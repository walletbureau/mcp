/**
 * Who pays for a call and with what (specs/041-mcp.md §1, §2).
 *
 * In wallet mode the package runs the x402 cycle itself: it receives the 402 from the API,
 * signs the payment with the key from the environment and retries the request. This is how
 * it works in Claude Desktop/Cursor — MCP clients cannot pay on their own, and there is
 * nobody to pay on their behalf.
 *
 * The private key lives only in the environment of the user's process: it never reaches
 * logs or tool responses — at most the payer's address is visible externally.
 */
import { x402Client, type PaymentPolicy } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';
import type { McpConfig } from './config.ts';

/** The cap is set in dollars, while requirements arrive in atomic USDC units (6 decimals). */
const USDC_ATOMIC_PER_USD = 1_000_000;

export interface Payer {
  /** fetch for API requests: paying in wallet mode, plain in the other modes. */
  readonly fetchImpl: typeof globalThis.fetch;
  /** Address the money leaves from; null when the payer is not a wallet. */
  readonly payerAddress: string | null;
}

/**
 * Never sign anything above the cap. The check lives next to the payment client, not in
 * the tool description: the remote server names the price, and the model's prompt does
 * not constrain it.
 */
export function createSpendCapPolicy(maxPriceUsd: number): PaymentPolicy {
  const capAtomic = BigInt(Math.round(maxPriceUsd * USDC_ATOMIC_PER_USD));
  return (_version, requirements) =>
    requirements.filter((requirement) => {
      // Strictly a decimal string: BigInt('0x50000') would parse as hex and the cap would
      // be compared against the wrong amount. Anything else is not our format — do not pay.
      if (!/^\d+$/.test(requirement.amount)) return false;
      return BigInt(requirement.amount) <= capAtomic;
    });
}

export function createPayer(config: McpConfig): Payer {
  if (config.mode !== 'wallet' || !config.X402_PRIVATE_KEY) {
    return { fetchImpl: fetch, payerAddress: null };
  }
  const account = privateKeyToAccount(config.X402_PRIVATE_KEY as `0x${string}`);
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: account,
    policies: [createSpendCapPolicy(config.X402_MAX_PRICE_USD)],
  });
  return { fetchImpl: wrapFetchWithPayment(fetch, client), payerAddress: account.address };
}
