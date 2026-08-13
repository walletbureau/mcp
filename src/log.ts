/**
 * Logs of the stdio server go ONLY to stderr: stdout is owned by the MCP transport
 * (line-delimited JSON-RPC), and any stray line there breaks the client session. Hence
 * no console and no @agenttrust/shared here: the package is published to npm and must be
 * self-contained (041 §2).
 */
export function logStderr(message: string): void {
  process.stderr.write(`[walletbureau-mcp] ${message}\n`);
}
