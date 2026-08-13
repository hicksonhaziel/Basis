# Four-minute demo script

Target: **3:50–4:00**. The demo is proof-first because KeeperHub judges weight real onchain execution most heavily. Record at 1080p in a clean browser profile with notifications disabled and browser zoom around 110%.

## Core message

> Basis is a deterministic execution underwriter. An agent requests a bounded onchain job and deadline; Basis prices the changing gas and reliability cost, routes execution through KeeperHub, and independently verifies the result.

## Prepare these screens before recording

Keep browser tabs in this exact left-to-right order. Load every page completely before pressing record.

1. **Basis dashboard — execution tape**
   `https://outstanding-motivation-production-c0ff.up.railway.app/#executions`
2. **Basescan — representative transaction**
   `https://sepolia.basescan.org/tx/0x34a4070605bf2e813fef81b25d1530798350d8b6ae9a45f183d5c3150e58b474`
3. **GitHub README — architecture**
   `https://github.com/hicksonhaziel/Basis#architecture`
4. **KeeperHub Marketplace — Basis workflow list**
   Open the view that visibly shows all six Basis workflows and their custom fields.
5. **Dynamic-pricing bounty proposal**
   `https://github.com/hicksonhaziel/Basis/blob/main/docs/BOUNTY-DYNAMIC-PRICING.md`

Also prepare one **Kiro MCP screen** before recording. Do not type commands live. Show the four Basis tools, a successful `basis_marketplace_catalog` response, and a prepared `basis_quote` response if available.

Use this quote input:

```json
{
  "jobType": "weth.wrap",
  "params": { "amount": "1000000000000" },
  "chainId": 84532,
  "deadlineTier": "5m",
  "refundRecipient": "0x1111111111111111111111111111111111111111"
}
```

The amount is `0.000001` test ETH. A quote records an intent but does not submit a transaction.

## Four-minute run of show

| Time | Screen | Purpose |
|---|---|---|
| 0:00–0:35 | Dashboard execution tape → Basescan | Prove real onchain execution first |
| 0:35–1:05 | Dashboard hero | Explain the problem and product |
| 1:05–1:35 | GitHub architecture | Show KeeperHub integration and trust boundaries |
| 1:35–2:10 | KeeperHub Marketplace | Show discoverability and six public workflows |
| 2:10–2:45 | Kiro MCP screen | Demonstrate agent discovery and deterministic quoting |
| 2:45–3:25 | Dashboard metrics and pricing | Show reliability, observability, and economics |
| 3:25–3:50 | Dynamic-pricing proposal | Show originality and onboarding contribution |
| 3:50–4:00 | Dashboard hero | Deliver the close |

## Exact narration and actions

### 0:00–0:35 — Proof first

**Start on:** dashboard `#executions`, with the newest transaction row visible.

**Action:** Point to the transaction tape, then switch to the prepared Basescan tab. Do not wait for a new transaction.

> “Before I explain Basis, here is the result: a real Base Sepolia transaction from the committed execution tape. This public hash is one of 24 WETH benchmark transactions submitted through KeeperHub Direct Execution. The Basis ledger records it as sponsored and deadline-hit; Basescan independently proves the transaction exists and succeeded. This is testnet execution proof, not a paid Marketplace settlement.”

On Basescan, point only to the network, successful status, transaction hash, and block. Do not claim Basescan proves KeeperHub sponsorship; that attribution comes from the Basis ledger.

### 0:35–1:05 — Problem and product

**Action:** Return to the dashboard and scroll to the top.

> “Agents can decide what should happen, but execution cost is not fixed. Gas, congestion, urgency, retries, and failure exposure change on every request. A static price either overcharges the buyer or loses money for the seller. Basis turns that uncertainty into an expiring deterministic quote, then executes a strictly bounded job through KeeperHub and verifies what actually landed.”

Point briefly to the three-step route: Quote, KeeperHub, Independent RPC.

### 1:05–1:35 — Architecture

**Action:** Switch to the GitHub architecture tab. Keep the diagram centered.

> “The buyer agent discovers Basis through MCP. Free quote and status calls reach the Basis operator. Paid execution must enter through the matching KeeperHub Marketplace tier, which forwards only a quote ID. The operator owns pricing, adapter policy, idempotency, recovery, and independent verification. KeeperHub owns simulation and transaction execution. The chain supplies the final receipt.”

Do not scroll through implementation details. The system diagram is enough.

### 1:35–2:10 — KeeperHub surfaces

**Action:** Switch to the Marketplace tab. Show all six public workflows and briefly open one input schema if already prepared.

> “Basis uses KeeperHub as both storefront and execution provider. The Marketplace exposes a free quote workflow, four paid order tiers, and status. The four fixed tiers are a safe bridge for dynamic execution cost: one cent, five cents, twenty-five cents, and one dollar. Paid workflows accept only the authenticated quote ID, never arbitrary target contracts or calldata.”

Keep credentials, account balances, payment details, and private workflow configuration off screen.

### 2:10–2:45 — Agent and MCP demonstration

**Action:** Switch to the prepared Kiro MCP screen. Show the tool list, then the catalog result, then the prepared quote response.

> “An agent sees four local Basis tools: quote, status, evidence, and Marketplace catalog. The catalog returns the six KeeperHub workflows and prices. A quote request validates the typed WETH job, simulates through KeeperHub, reads fee and FX evidence, and returns a signed expiry, price breakdown, and required tier. No transaction is sent here. Paid authority remains with KeeperHub, so the local MCP cannot bypass the Marketplace.”

Do not expose the complete quote signature, private RPC URL, API key, authorization header, or workflow credential.

### 2:45–3:25 — Reliability and economics

**Action:** Return to the dashboard. Show the four headline metrics, the execution tape, then click **Pricing** in the top navigation.

> “The committed benchmark contains 24 public testnet transactions and 96 hash-chained audit events, with every recorded benchmark deadline hit. The operator does not blindly retry an ambiguous submission; it keeps the original idempotency identity and reconciles that execution. Pricing is versioned arithmetic, not an LLM decision. This 1,003-observation historical report shows how deadline urgency changes fee coverage, while the dashboard keeps historical results separate from live operator metrics.”

Pause briefly on the coverage bars. Do not call the backtest live revenue, independently reproducible raw history, or paid economics.

### 3:25–3:50 — Bounty and usefulness

**Action:** Switch to the dynamic-pricing proposal. Show the problem, proposed `price.mode: "dynamic"`, and reference tier ladder.

> “Basis also exposes a platform opportunity. KeeperHub listings are fixed-price, but execution cost is stochastic. The bounty proposal adds signed, expiring dynamic quotes with a buyer maximum-price cap and single-use identity. Basis ships the working tier-ladder reference today, plus the schema and security model needed to remove that workaround.”

### 3:50–4:00 — Close

**Action:** Return to the dashboard hero and stop moving the cursor.

> “Agents decide. Basis prices. KeeperHub executes. The chain proves the result. Basis is execution, priced.”

Hold the final frame for two seconds before ending the recording.

## Claims to make precisely

Say:

- “24 public Base Sepolia benchmark transactions.”
- “Submitted through KeeperHub Direct Execution.”
- “Sponsorship is KeeperHub-reported in the Basis ledger.”
- “The transaction hash and success are public on Basescan.”
- “Six workflows are publicly visible in the KeeperHub Marketplace.”
- “The pricing report is a Basis-reported historical backtest.”

Do not say:

- that a paid Marketplace call completed
- that the representative transaction proves an x402 or MPP payment
- that a live refund or mainnet execution completed
- that a Morpho transaction is included
- that Basescan independently proves KeeperHub attribution or sponsorship
- that the 1,003-observation report is live data

## Failure-proof recording plan

- Do not perform a live payment or new execution during the video.
- Do not type the quote live. Preload the successful response.
- If the quote service is unavailable, show the prepared response and say “This is the deterministic quote shape produced by the deployed operator.”
- If Basescan is slow, keep a full-page screenshot of the same public transaction ready.
- If the Marketplace requires login, preload it before recording and hide account-identifying controls.
- If a tab fails, continue; do not troubleshoot on camera.

## Final recording checklist

- [ ] Every browser tab is loaded and positioned at the exact section needed.
- [ ] Kiro shows only the MCP tool list, catalog, and redacted quote result.
- [ ] Browser zoom makes hashes and workflow names readable at 1080p.
- [ ] Notifications, bookmarks, wallet balances, credentials, and private URLs are hidden.
- [ ] The spoken run finishes between 3:50 and 4:00 in one rehearsal.
- [ ] The final video visibly includes the public transaction hash, KeeperHub workflows, MCP tools, and dashboard metrics.
- [ ] The complete exported video is watched once before upload.
- [ ] The uploaded video URL is added to `SUBMISSION.md` before final submission.
