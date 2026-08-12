# Demo script

Target length: **2 minutes 30 seconds**. Use a clean browser profile, large text and preloaded tabs. Do not show `.env.local`, request headers, signatures, credentials or private RPC URLs.

## Tabs

1. Live Basis dashboard
2. KeeperHub Marketplace workflow list
3. Terminal in repository
4. GitHub `docs/EVIDENCE.md`

## Script

### 0:00–0:15 — Problem

**Screen:** Dashboard masthead.

> “Onchain execution cannot be priced like a static API call. Gas, congestion and urgency change per request. Basis turns those variables into a deterministic quote, then executes through KeeperHub under a strict adapter policy.”

### 0:15–0:35 — Truthful public surface

**Screen:** Status labels and provenance cards.

> “This dashboard separates public-chain facts, KeeperHub-reported facts and Basis-local records. The disclosed evidence is Base Sepolia. No paid call, refund, mainnet execution or unavailable Morpho transaction is claimed.”

Point to the publication, unpaid and not-refunded labels. Do not call publication a sale.

### 0:35–1:00 — Architecture

**Screen:** README architecture diagram.

> “Buyer agents discover Basis through MCP. Free quote and status tools can call the operator directly. Paid execution must enter through KeeperHub Marketplace, which gates the matching fixed-price tier and forwards only a quote ID. The Railway operator owns pricing, simulation, policy, recovery and independent verification.”

### 1:00–1:25 — MCP

**Screen:** Terminal.

Run the MCP server from the configured client, then show the tool list:

- `basis_quote`
- `basis_status`
- `basis_evidence`
- `basis_marketplace_catalog`

> “The local MCP cannot submit paid work. That boundary prevents an agent from bypassing KeeperHub payment authority.”

Call `basis_marketplace_catalog` and show the six workflow names and prices.

### 1:25–1:50 — Quote without execution

**Screen:** Call `basis_quote` with a small Base Sepolia WETH wrap request.

```json
{
  "jobType": "weth.wrap",
  "params": { "amount": "1000000000000" },
  "chainId": 84532,
  "deadlineTier": "5m",
  "refundRecipient": "0x1111111111111111111111111111111111111111"
}
```

> “A quote records a canonical intent and complete price breakdown, but sends no transaction. Execution requires the exact paid tier, quote integrity, expiry, one-time consumption, re-simulation and final preflight.”

If the live oracle or simulation is unavailable, use a prerecorded successful quote response rather than changing production policy.

### 1:50–2:15 — Recovery and evidence

**Screen:** Recovery guarantees, then audit verification.

Click **Verify chain**, then **Simulate tamper**.

> “Basis never treats KeeperHub completion alone as truth. It verifies an independent RPC receipt and adapter postconditions. Ambiguous submission becomes uncertain and is never blindly rebroadcast. The browser recomputes the committed audit chain and detects a local tamper immediately.”

### 2:15–2:30 — Close

**Screen:** Marketplace workflow list and GitHub.

> “Basis is execution, priced: deterministic underwriting, KeeperHub execution, MCP discovery and evidence that distinguishes what is public, reported and still unavailable.”

## Recording checklist

- [ ] Dashboard, API and GitHub load in an incognito window.
- [ ] KeeperHub workflow list is visible without exposing account secrets.
- [ ] MCP tool list is prepared before recording.
- [ ] No live paid order or new blockchain transaction is required.
- [ ] Every spoken status matches `docs/EVIDENCE.md`.
- [ ] Export at 1080p and watch the complete final file once.
