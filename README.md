# @walletbureau/mcp

**Check who you are about to pay.** An MCP server that gives your agent one tool: score the
behavioral risk of a wallet on Base before sending it money.

The score comes from the full history of x402 / EIP-3009 USDC payments on Base — how long the
address has existed, who pays it, how concentrated its inflows are, whether its activity just
spiked. You get a number from 0 to 100, a verdict (`ok` / `caution` / `avoid`) and the risk flags
that produced them, each with a reason in plain language.

These are risk signals, not accusations. Methodology: <https://walletbureau.com/methodology>

## Install

```bash
npm i @walletbureau/mcp --ignore-scripts
```

The package ships ready-to-run JavaScript. There are no install scripts, no native modules and
no build step on your machine — `--ignore-scripts` changes nothing here, and that is on purpose.

### Claude Code

```bash
claude mcp add walletbureau -- npx -y @walletbureau/mcp
```

### Claude Desktop / Cursor / any MCP client

Add this to your MCP configuration (`claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "walletbureau": {
      "command": "npx",
      "args": ["-y", "@walletbureau/mcp"]
    }
  }
}
```

That is the whole setup. With no credentials the server runs on the public free quota — a few
checks per day — which is enough to try it. To keep going, pick a payment mode below.

## Paying for checks

A full check costs **$0.01**. The server picks its mode from the environment:

| Mode | Set this | What happens |
|---|---|---|
| **Free demo** | nothing | Uses the public demo quota (a few checks per day per IP). |
| **Prepaid key** | `WALLETBUREAU_API_KEY=atk_…` | Each check is debited from the key's balance. No crypto involved. |
| **Wallet (x402)** | `X402_PRIVATE_KEY=0x…` | The server pays $0.01 in USDC on Base per check, automatically, over [x402](https://x402.org). |

If both are set, the prepaid key wins — its balance is already paid for, and an on-chain payment
would be a second charge.

```json
{
  "mcpServers": {
    "walletbureau": {
      "command": "npx",
      "args": ["-y", "@walletbureau/mcp"],
      "env": { "WALLETBUREAU_API_KEY": "atk_your_key_here" }
    }
  }
}
```

### If you pay from a wallet

`X402_PRIVATE_KEY` is a real spending key. Treat it like one:

- Use a **dedicated wallet** funded with a small amount of USDC — not your main account.
- The key never leaves your machine. It is used to sign x402 payments and is never logged, never
  sent to the service and never included in tool output. The service only ever sees the payment.
- `X402_MAX_PRICE_USD` (default `0.10`) caps what a single call may cost. The price is quoted by
  the remote server, so this check lives in code next to the signing step — not in a prompt.

## Tools

### `check_counterparty` — paid

Input: `{ "address": "0x…" }` — a wallet address on Base.

Returns the full report: score, verdict, risk flags with reasons, and the aggregate statistics
behind them. Its price is visible to your client before the call, both in the tool description and
in the tool's `_meta` under `walletbureau/pricing`.

```json
{
  "address": "0x…",
  "score": 74,
  "verdict": "ok",
  "flags": [
    { "code": "activity_spike", "severity": "low",
      "reason": "Volume over the last 24 h is 12× the median of the last 30 days" }
  ],
  "stats": {
    "first_seen": "2025-11-02T…Z", "tx_in": 1204, "tx_out": 17,
    "volume_in_usd": "604.31", "volume_out_usd": "12.05",
    "distinct_payers": 311, "confidence_basis": "confirmed+probable"
  },
  "meta": { "computed_at": "…", "cache_age_seconds": 312, "api_version": "v1", "disclaimer": "…" }
}
```

The response schema is a stable contract: fields are only ever added, and a rename or removal
means a new API version. Published as JSON Schema alongside the API.

### `get_service_stats` — free

No input. Public counters of the index: addresses indexed, transfers ingested, scores served.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `API_BASE_URL` | `https://walletbureau.com` | Where the service lives. Change it only to point at your own deployment. |
| `WALLETBUREAU_API_KEY` | — | Prepaid API key, `atk_…`. |
| `X402_PRIVATE_KEY` | — | Private key that pays per call over x402. |
| `X402_MAX_PRICE_USD` | `0.10` | Hard cap on the price of a single paid call. |
| `REQUEST_TIMEOUT_MS` | `5000` | Timeout for an unpaid request to the service. |
| `PAYMENT_TIMEOUT_MS` | `60000` | Budget for a paid call, including signing and on-chain settlement. |

The server logs to stderr only — stdout belongs to the MCP protocol.

## What this server does not do

No scoring logic and no data of its own: it is a thin wrapper over the public HTTP API, so a fix
to the methodology reaches you without a package upgrade. No local cache either — the service
caches, and a second copy would only drift from it.

## License

Apache-2.0
