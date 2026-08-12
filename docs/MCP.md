# MCP integration

Basis has two complementary MCP surfaces. They must not be confused.

## Local Basis MCP

`src/mcp/server.ts` is a stdio server for Kiro and other local MCP clients. It talks to the public Basis API and deliberately cannot authorize paid execution.

| Tool | Behavior |
|---|---|
| `basis_quote` | Creates and records a deterministic quote; never executes |
| `basis_status` | Reads order, execution, verification and refund state |
| `basis_evidence` | Reads the redacted public evidence package |
| `basis_marketplace_catalog` | Lists KeeperHub workflow names, schemas and prices |

Run it with:

```bash
BASIS_PUBLIC_BASE_URL=https://your-basis-host.example npm run mcp
```

Example Kiro workspace configuration (`.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "basis": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/Basis",
      "env": {
        "BASIS_PUBLIC_BASE_URL": "https://your-basis-host.example"
      },
      "disabled": false
    }
  }
}
```

Do not put API keys, signing keys, workflow credentials or private RPC URLs in a committed MCP configuration.

## KeeperHub Marketplace MCP

The six public storefront workflows are hosted by KeeperHub. Free tools request quotes and status; four paid tools gate asynchronous order acceptance at fixed USDC tiers.

Paid execution must use KeeperHub’s Marketplace tool. Calling the Basis `/orders` route directly is not a supported buyer path: it requires a private tier credential and does not prove Marketplace payment.

```text
agent → KeeperHub paid MCP tool → payment gate → workflow webhook
      → Basis order admission → KeeperHub Direct Execution
```

## Why execution is split

The local MCP server is a discovery and read interface. The KeeperHub MCP surface is the commercial authority. The Basis operator remains the deterministic execution authority. This prevents a convenience client from bypassing payment, selecting arbitrary calldata or claiming a settlement that KeeperHub did not expose.

## Example quote input

```json
{
  "jobType": "weth.wrap",
  "params": { "amount": "1000000000000" },
  "chainId": 84532,
  "deadlineTier": "5m",
  "refundRecipient": "0x1111111111111111111111111111111111111111"
}
```

The amount is an atomic-unit string. A quote records state in the configured Basis deployment but sends no transaction.

## Known KeeperHub limitation

Dedicated per-workflow MCP schemas have previously been derived from the Manual trigger and may not preserve custom listing inputs. The aggregate Marketplace call path and direct Marketplace REST path preserve the listing body. Publication does not by itself prove that a paid external call completed; test with a buyer-controlled account before claiming activation or settlement.
