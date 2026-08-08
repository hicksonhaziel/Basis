# Basis — Execution, Priced

**Final product and engineering specification**  
**Hackathon:** KeeperHub — Agents Onchain 2026  
**Status:** Approved concept; ready for implementation  
**Core thesis:** Onchain execution has a stochastic cost, but KeeperHub marketplace prices are fixed. Basis creates the missing market: it quotes a guaranteed price for landing a transaction by a deadline, accepts payment, executes through KeeperHub, and publishes the resulting P&L and reliability record.

> **AI sets the priors. Arithmetic sets the price. The chain sets the truth.**

---

## 1. Executive summary

KeeperHub's marketplace has plenty of agents selling information—risk scores, health factors, yield data, and transaction plans—but almost no agents selling actual execution. The reason is economic: information has a mostly fixed marginal cost, while execution cost changes with gas prices, congestion, retries, urgency, and MEV risk. Yet every paid workflow observed in the August 7 marketplace snapshot uses a fixed price.

**Basis is an execution market maker for AI agents.** A buyer submits a supported onchain job and a deadline. Basis:

1. Simulates the exact action through KeeperHub.
2. Estimates the gas-price distribution over the requested deadline.
3. Returns an expiring, reproducible quote in USDC.
4. Accepts payment through KeeperHub's x402/MPP marketplace surface.
5. Re-simulates and executes through KeeperHub with deterministic idempotency.
6. Verifies the independently fetched onchain receipt.
7. Records quoted cost, actual cost, deadline performance, and margin.
8. Refunds the execution fee through KeeperHub if the contractual deadline is missed.

The buyer receives a fixed known price. Basis takes the gas and reliability risk. KeeperHub earns its marketplace fee and supplies the execution infrastructure.

### One-line pitch

> **Basis quotes what it costs to land an onchain transaction by a deadline, takes the gas risk, executes it through KeeperHub, and opens the book.**

### The memorable comparison

Most marketplace agents sell weather reports. Basis delivers the package—and quotes delivery based on current fuel prices and urgency.

---

## 2. The research insight

A reproducible snapshot of KeeperHub's public OpenAPI marketplace specification on August 7, 2026 contained:

- **108 total workflow listings**
- **68 paid listings**
- **40 free listings**
- **68 of 68 paid listings using fixed-price mode**
- A large concentration of read-only information services
- Very few meaningful execution services

The snapshot is preserved at:

```text
research/keeperhub-openapi-2026-08-07.json
```

The market structure suggests a specific product gap:

```text
Fixed x402 price + stochastic gas cost = weak supply of execution services
```

A seller charging a static amount must either:

- Charge high enough to survive gas spikes, overcharging buyers most of the time; or
- Charge competitively, then lose money during congestion or retries.

Basis solves this with a quote before the paid order. The current fixed-price limitation is bridged with price tiers, while the bounty proposal argues for native dynamic payment challenges.

---

## 3. Product definition

### 3.1 What Basis is

Basis is a **non-custodial-by-default, gas-underwritten execution service** for AI agents.

It sells three things:

1. **Execution:** a supported transaction is submitted through KeeperHub.
2. **Deadline:** the transaction is promised within a defined service window.
3. **Price certainty:** the buyer pays the quoted service fee rather than absorbing gas-price volatility.

### 3.2 What Basis is not

- Not a trading bot.
- Not an agent that decides what financial strategy the buyer should follow.
- Not another liquidation monitor or wallet guardian.
- Not a generic wallet that signs arbitrary calldata.
- Not an LLM-based gas estimator.
- Not insurance against adverse market movement.
- Not a promise that every arbitrary transaction can be executed.

The buyer decides **what** should happen. Basis prices and delivers **how and when** it happens.

### 3.3 The contractual promise

A valid Basis order means:

> "Basis will submit the quoted job through KeeperHub and obtain a verified successful receipt before the quoted deadline, or refund the Basis execution fee."

The refund covers the **Basis service fee**, not market losses, token-price movement, liquidation losses, or protocol-side effects.

### 3.4 Why the deadline matters

Urgency has economic value:

- A position-protection call may become useless after liquidation.
- A settlement call may block downstream work.
- A claim may expire.
- A keeper action may lose an opportunity if delayed.
- A swap exposed to public routing may incur MEV loss.

Basis turns urgency into an explicit product rather than an undocumented best effort.

### 3.5 Execution authority: what Basis can and cannot do

Basis cannot perform every possible Web3 action without the asset owner's authorization. If a call moves a customer's tokens or must execute with the customer as `msg.sender`, the customer must sign the transaction, sign a bounded intent, delegate a smart-account capability, or deposit assets into an execution contract. Basis never claims otherwise and never asks for a customer private key.

The system separates three wallets:

| Wallet | Role | Controlled by |
|---|---|---|
| **Customer payment wallet** | Pays the Basis service fee through x402/MPP | Customer or customer agent |
| **Basis execution wallet** | Pays gas and submits the onchain job through KeeperHub | Basis organization, secured by KeeperHub/Turnkey |
| **Customer asset wallet** | Holds the customer's positions and tokens | Customer; Basis has no access unless narrowly authorized |

For a permissionless action, the customer asset wallet is not involved. The customer pays Basis in USDC, Basis's KeeperHub wallet pays gas and calls the public function, and the protocol applies its own rules. For a customer-specific action, a separate signed authorization is mandatory.

The precise MVP offer is:

> **Basis is an SLA-backed keeper marketplace. AI agents pay a fixed USDC quote to have supported permissionless onchain actions executed through KeeperHub by a deadline. No destination-chain gas token, execution wallet, or customer-key custody is required.**

What Basis gives the customer:

1. **Gas abstraction:** pay the service fee in USDC instead of maintaining the destination chain's gas token.
2. **Execution:** Basis's KeeperHub wallet submits the supported transaction.
3. **Deadline commitment:** urgency is an explicit service tier.
4. **Reliability:** simulation, idempotency, safe retry handling, polling, and postcondition verification are included.
5. **Price certainty:** the service fee is known before execution.
6. **Accountability:** Basis refunds its service fee when it fails the defined promise.
7. **Proof:** the result includes the KeeperHub execution ID, public transaction, verified receipt, completion time, and deadline outcome.

### 3.6 The two Basis product modes

Both modes use the same core product—quote, payment, KeeperHub execution, deadline settlement, and open-book accounting. They differ only in where execution authority comes from.

#### Mode 1 — Permissionless Keeper Execution (hackathon MVP)

```text
No customer asset authorization
No customer private key
No custody
Basis pays gas
KeeperHub submits
Customer pays a fixed USDC service fee
```

Supported task categories:

- DAO and timelock execution after the operation becomes publicly executable
- Protocol epoch finalization
- Auction settlement
- Reward claiming on behalf where the contract fixes the beneficiary
- Permissionless protocol keeper functions
- Public maintenance and synchronization calls
- Proven message relay or distribution finalization where anyone may trigger the transition

The contract itself supplies the authority: anyone may call the function, while protocol rules determine the result and recipient. Basis is paid to make that state transition happen reliably and before the deadline.

> **What the customer buys:** “Make this public state transition happen before my deadline.”

Example:

```text
Customer agent pays Basis $0.25 USDC
  → Basis KeeperHub wallet calls Timelock.execute(operationId)
  → the timelock performs the already-approved DAO action
  → Basis returns the verified receipt
```

Basis does not control the DAO treasury; it only triggers the permissionless execution after governance has authorized it.

#### Mode 2 — Authorized Intent Execution (post-MVP extension)

```text
Customer signs a narrowly bounded intent
Basis cannot exceed the signed permission
KeeperHub relays the action
Customer assets remain in a customer-controlled account
```

Supported task categories:

- Aave repay or supply
- Token swaps
- Approval revocation
- Treasury payments
- Position rebalancing

A signed intent binds the exact chain, smart account, target, function, asset, maximum amount, nonce, and expiry. A compatible Safe, ERC-4337 account, session-key module, or protocol-specific permit verifies it. The Basis KeeperHub wallet acts as relayer and gas payer; it never receives the customer's private key or general wallet control.

> **What the customer buys:** “Execute this exact wallet-authorized action before my deadline.”

Mode 2 is an extension, not a prerequisite for validating Basis's first-place thesis. The hackathon product is complete with Mode 1: Basis still dynamically prices gas and deadline risk, sells execution through the KeeperHub marketplace, produces a real transaction as the purchased service, and publishes the resulting economics.

### 3.7 Why agents pay for a permissionless call

Permissionless means *anyone may call*, not that the call is free or guaranteed to happen. Someone must still operate a wallet, hold gas, simulate, estimate fees, submit, avoid duplicate execution, monitor the result, and absorb cost volatility. Keeper networks, relayers, liquidators, solvers, and automation protocols are businesses for exactly this reason.

Basis turns that operational burden into a four-step customer experience:

```text
quote → pay USDC → receive verified execution → receive refund if Basis misses its promise
```

---

## 4. Initial job catalog

Basis does **not** accept arbitrary calldata in the primary product. It starts with typed job classes whose schemas, gas profiles, verification rules, and safety properties are known.

### 4.1 Mode 1 MVP: permissionless keeper jobs

These jobs spend Basis's gas but do not require Basis to custody the buyer's principal or act as the customer's wallet. The target contract explicitly permits an arbitrary caller to trigger the state transition.

| Job class | Purpose | Why it belongs |
|---|---|---|
| `governance.execute` | Execute an approved, matured timelock operation | Strong real-world deadline; treasury authority remains in the timelock |
| `keeper.poke` | Call a permissionless maintenance/keeper function | Pure execution service; no buyer funds |
| `protocol.settle` | Invoke a permissionless settlement or auction-finalization function | Deadline has real utility |
| `rewards.claimFor` | Claim rewards to a fixed beneficiary where claim-on-behalf is supported | Verifiable recipient; no custody |
| `distribution.finalize` | Finalize an eligible epoch or distribution | Simple, deterministic state transition |
| `message.relay` | Relay a proven message after its proof becomes valid | Anyone may pay gas; protocol verifies the proof |

The first production adapter will be selected from a real permissionless mainnet function that can be safely and repeatedly invoked. The adapter must pass the checklist in section 4.4. Its transaction—not an attestation or cosmetic self-transfer—is the service the buyer purchased.

### 4.2 Benchmark jobs

These generate repeatable data for pricing and reliability tests:

| Job class | Typical role |
|---|---|
| `erc20.transfer` | Canonical low-complexity gas benchmark using Basis-owned test funds |
| `weth.wrap` / `weth.unwrap` | Deterministic contract-write benchmark |
| `test.counter.increment` | Testnet-only chaos and volume workload |

Benchmark jobs are evidence infrastructure, not the primary product story.

### 4.3 Mode 2 extension: authorized intent jobs

After the permissionless product is complete, Basis may add one customer-authorized showcase. These jobs are never described as permissionless and never rely on Basis possessing the customer's key.

| Job class | Authorization model |
|---|---|
| `aave.repayFor` | Signed smart-account intent or protocol-supported permit, capped by token, amount, target, nonce, chain, and expiry |
| `aave.supplyFor` | Signed smart-account intent or narrowly scoped token authorization |
| `swap.execute` | Signed exact-input/max-slippage intent with a verified route; optional private-routing premium |
| `erc20.revokeAuthorized` | Safe/module/session-key authorization allowing only `approve(spender, 0)` |
| `treasury.pay` | Safe or smart-account policy authorizing an exact recipient, token, amount, nonce, and expiry |
| `position.rebalance` | Bounded smart-account capability covering only approved protocols, assets, and exposure limits |

Mode 2 requires a compatible Safe, ERC-4337 account, session-key module, or protocol-specific permit. An ordinary customer EOA cannot be treated as though Basis were its `msg.sender`. If the required authorization is absent or invalid, Basis refuses to quote the job.

The most intuitive optional deadline demo is `aave.repayFor`: delayed execution can result in liquidation. It remains explicitly separate from the Mode 1 MVP because it introduces authorization, allowance, and principal risk. It is cut before any permissionless core capability.

### 4.4 Adapter admission checklist

A job adapter is not enabled unless all answers are yes:

- Is the target chain explicitly supported by KeeperHub?
- Is the target contract verified or pinned by code hash?
- Is the ABI pinned and reviewed?
- Are all input fields schema-validated?
- Can KeeperHub simulate the exact action?
- Is post-execution success independently verifiable?
- Is the maximum gas estimate capped?
- Is native value forbidden or explicitly capped?
- Does the call avoid unrestricted `delegatecall` behavior?
- Is the action permissionless under Mode 1, or does Mode 2 include a cryptographically verified authorization binding the exact account, target, function, asset, maximum amount, nonce, chain, and expiry?
- Does the adapter avoid customer-key custody and refuse to treat the Basis wallet as the customer's `msg.sender`?
- Can an idempotency key be deterministically derived from the economic intent?
- Is there a safe response to `timeout` or `not_found` that does not blindly re-broadcast?

---

## 5. Deadline products

The service-level tiers are the primary SKUs.

| Tier | Pricing percentile | Promise | Intended use |
|---|---:|---|---|
| `next-block` | P99 | Aggressive inclusion target | Urgent keeper/protection actions |
| `5m` | P95 | Land within five minutes | Default time-sensitive execution |
| `1h` | P75 | Land within one hour | Cost-sensitive scheduled work |
| `best-effort` | P50 | Execute when cost conditions are favorable, before a longer expiry | Routine maintenance |

The percentile is not the only input. Each tier also controls:

- Quote validity window
- Maximum retry count
- Retry timing
- Allowed gas escalation
- Refund eligibility
- Optional private-routing surcharge

A shorter deadline costs more because Basis accepts a higher probability of paying elevated gas.

---

## 6. Pricing model

### 6.1 Formula

The v1 quote is transparent and reproducible:

```text
expectedGasUnits = keeperHubSimulation.gasEstimate

protectedGasPrice = percentile(
  projectedBaseFee + priorityFee,
  deadlineTier
)

marketExecutionCostUSD =
  expectedGasUnits
  × protectedGasPrice
  × nativeAssetUsd

riskCostUSD = marketExecutionCostUSD × retryPremium

privateRoutingFeeUSD = privateRouting ? configuredPrivateFee : 0

quoteUSD = roundToTier(
  marketExecutionCostUSD
  + riskCostUSD
  + privateRoutingFeeUSD
  + fixedPlatformOverheadUSD
  + targetMarginUSD
)
```

### 6.2 Inputs

| Input | Source |
|---|---|
| Gas units | KeeperHub Direct Execution simulation |
| Base-fee history | Chain RPC `eth_feeHistory` through viem |
| Priority-fee samples | `eth_feeHistory` reward percentiles |
| Native asset/USD | Chainlink feed, read onchain |
| Retry premium | Empirical failure statistics grouped by deterministic/AI-assisted cause labels |
| KeeperHub marketplace fee | Configured from marketplace economics |
| Sponsorship status | KeeperHub execution status and organization configuration |
| Margin target | Basis configuration, versioned in every quote |

### 6.3 Pure pricing function

The pricing function has no network, storage, clock, or model dependency:

```ts
export interface QuoteInputs {
  gasEstimate: bigint;
  feeSamples: FeeSample[];
  horizonSeconds: number;
  nativeAssetUsd: Decimal;
  retryPremiumBps: number;
  targetMarginBps: number;
  fixedOverheadUsd: Decimal;
  privateRouting: boolean;
  pricingModelVersion: string;
}

export interface QuoteBreakdown {
  protectedGasPriceWei: bigint;
  marketExecutionCostUsd: Decimal;
  riskCostUsd: Decimal;
  privateRoutingFeeUsd: Decimal;
  targetMarginUsd: Decimal;
  rawPriceUsd: Decimal;
  payableTierUsd: Decimal;
}

export function priceQuote(inputs: QuoteInputs): QuoteBreakdown;
```

Every historical quote must replay through the same versioned function and produce the same price.

### 6.4 Quote object

```json
{
  "quoteId": "q_01J...",
  "jobHash": "0x...",
  "jobType": "protocol.settle",
  "chainId": 8453,
  "deadlineTier": "5m",
  "deadlineAt": "2026-08-10T12:05:00Z",
  "expiresAt": "2026-08-10T12:00:30Z",
  "priceUsd": "0.25",
  "paymentTier": "basis-order-t3",
  "pricingModelVersion": "basis-v1",
  "breakdown": {
    "gasEstimate": "118420",
    "protectedGasPriceWei": "22000000",
    "nativeAssetUsd": "3124.22",
    "marketExecutionCostUsd": "0.00814",
    "retryPremiumUsd": "0.00122",
    "marginUsd": "0.04064",
    "tierRoundingUsd": "0.20000"
  },
  "simulation": {
    "success": true,
    "wouldRevert": false,
    "from": "0x...",
    "to": "0x..."
  },
  "signature": "0x..."
}
```

The quote is signed by Basis and bound to the canonical job hash, expiry, model version, and payment tier.

---

## 7. Fixed-price marketplace bridge

KeeperHub's observed paid workflow model is fixed-price. Basis implements dynamic quoting as a two-stage protocol:

### Stage A: quote

```text
basis-quote
```

- Free or priced at the minimum practical amount
- Accepts the typed job and deadline tier
- Returns an expiring signed quote
- Does not move value
- Uses a read-only KeeperHub credential for simulation

### Stage B: order

```text
basis-order-t1
basis-order-t2
basis-order-t3
basis-order-t4
```

Illustrative fixed prices:

| Listing | Fixed payment |
|---|---:|
| `basis-order-t1` | $0.01 |
| `basis-order-t2` | $0.05 |
| `basis-order-t3` | $0.25 |
| `basis-order-t4` | $1.00 |

For higher-cost Ethereum jobs, additional tiers may be listed only if needed and within agentic-wallet limits.

The order call supplies `quoteId`. Basis verifies:

- Quote signature
- Quote expiry
- Job hash
- Required payment tier
- Quote not previously consumed
- Payment settlement status

A tier may exceed the raw quote because fixed tiers quantize the price. The quote breakdown exposes this explicitly as `tierRoundingUsd`.

### Bounty contribution

Basis will propose native dynamic pricing:

```json
{
  "x-payment-info": {
    "price": {
      "mode": "dynamic",
      "quoteEndpoint": "/quote",
      "currency": "USD",
      "quoteIdField": "quoteId",
      "expiresAtField": "expiresAt"
    }
  }
}
```

The proposal will include:

- Marketplace census and methodology
- Why stochastic execution cannot be safely sold at a fixed price
- Threat model for quote replay and tampering
- Signed quote schema
- Reference tier-ladder workaround
- Suggested OpenAPI and MCP behavior
- A starter template for execution sellers

---

## 8. System architecture

### 8.1 Component diagram

```text
┌──────────────────────── BUYER SIDE: untrusted ─────────────────────────┐
│                                                                        │
│  Claude Code / Cursor / Hermes / any MCP client        @basis/sdk      │
│                │                                         │             │
│                │ typed quote/order tool                  │ HTTP client │
│                ▼                                         │             │
│      KeeperHub per-workflow MCP server                   │             │
│      /mcp/w/basis-quote                                  │             │
│                │                                         │             │
│      @keeperhub/wallet handles x402/MPP payment           │             │
└────────────────┼─────────────────────────────────────────┼─────────────┘
                 │                                         │
                 └──────────────── HTTPS ──────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │ KeeperHub marketplace       │
                    │                             │
                    │ basis-quote                 │
                    │ basis-order-t1..t4          │
                    │                             │
                    │ x402 → Base USDC            │
                    │ MPP  → Tempo USDC.e         │
                    └──────────────┬──────────────┘
                                   │ paid order / webhook
                                   ▼
╔═════════════════════════════════════════════════════════════════════════╗
║                   BASIS CORE: deterministic TypeScript                  ║
║                                                                         ║
║  ┌──────────────────────┐      ┌────────────────────────────────────┐   ║
║  │ Quoter               │      │ Executor                           │   ║
║  │                      │      │                                    │   ║
║  │ KeeperHub simulation │      │ quote/payment validation           │   ║
║  │ eth_feeHistory       │      │ re-simulation                      │   ║
║  │ Chainlink FX         │      │ deterministic idempotency key      │   ║
║  │ pure price function  │      │ KeeperHub broadcast + status poll  │   ║
║  │ signed quote         │      │ receipt verification + refund      │   ║
║  └──────────┬───────────┘      └────────────────┬───────────────────┘   ║
║             │                                    │                       ║
║             └────────────────┬───────────────────┘                       ║
║                              ▼                                           ║
║              ┌─────────────────────────────────┐                         ║
║              │ Dual ledger                     │                         ║
║              │                                 │                         ║
║              │ SQLite: queryable source        │                         ║
║              │ JSONL: hash-chained evidence    │                         ║
║              └───────────────┬─────────────────┘                         ║
╚══════════════════════════════╪══════════════════════════════════════════╝
                               │
                   ┌───────────┴────────────┐
                   ▼                        ▼
       ┌──────────────────────┐  ┌─────────────────────────────────────┐
       │ Public dashboard     │  │ Hermes operator: read-only          │
       │                      │  │                                     │
       │ open execution book  │  │ natural-language intake             │
       │ P&L and hit rate     │  │ failure classification              │
       │ pricing error P50/95 │  │ reconciliation watchdog             │
       │ browser audit verify │  │ scheduled Telegram digest           │
       └──────────────────────┘  └─────────────────────────────────────┘

                KeeperHub Direct Execution API
                               │
              simulate → broadcast → poll → verified receipt
                               │
                               ▼
                       EVM public chains
```

### 8.2 Trust boundaries

| Component | Credential | Can move funds? | Why |
|---|---|---:|---|
| Public buyer | Buyer-owned agentic wallet | Only buyer-approved x402/MPP payment | Buyer controls its own safety policy |
| Quote service | KeeperHub read-only scope | **No** | It only simulates and reads |
| Hermes operator | KeeperHub read-only plugin | **No** | AI cannot sign, execute, or refund |
| Executor | KeeperHub write scope | **Yes** | Small deterministic service, no LLM |
| Dashboard | No secret | **No** | Reads public/exported ledger only |
| Payment fallback | Isolated payment credential | Payment settlement only | Cannot invoke arbitrary job execution |

The central security claim is:

> **The only component authorized to move execution value is deterministic TypeScript. The LLM is structurally unable to sign.**

---

## 9. End-to-end execution flow

```text
BUYER          MARKETPLACE        QUOTER         EXECUTOR       KEEPERHUB       CHAIN
  │                 │                │               │               │             │
  │ quote(job,tier) │                │               │               │             │
  ├────────────────>├───────────────>│               │               │             │
  │                 │                │ simulate:true │               │             │
  │                 │                ├──────────────────────────────>│ estimate/call │
  │                 │                │<──────────────────────────────┤<─────────────┤
  │                 │                │ eth_feeHistory ─────────────────────────────>│
  │                 │                │ Chainlink read ─────────────────────────────>│
  │                 │                │ pure deterministic pricing   │             │
  │ signed quote    │                │ append QUOTE_ISSUED           │             │
  │<────────────────┴────────────────┤               │               │             │
  │                                  │               │               │             │
  │ order(quoteId)  │                │               │               │             │
  ├────────────────>│ 402 challenge  │               │               │             │
  │<────────────────┤                │               │               │             │
  │ signed payment │                 │               │               │             │
  ├────────────────>│ settle USDC ────────────────────────────────────────────────>│
  │                 │ paid order ───────────────────>│               │             │
  │                 │                │               │ validate      │             │
  │                 │                │               │ re-simulate ─>│────────────>│
  │                 │                │               │ idempotent send────────────>│
  │                 │                │               │ poll status ─>│             │
  │                 │                │               │<─ verified receipt ─────────┤
  │                 │                │               │ append SETTLED               │
  │ result + proof  │<───────────────────────────────┤               │             │
  │<────────────────┤                │               │               │             │
  │                                  │               │               │             │
  │ missed deadline: executor refunds service fee through KeeperHub ─────────────>│
```

### 9.1 State machine

```text
DRAFT
  └─ successful simulation ─> QUOTED
       ├─ expiry ───────────> EXPIRED
       └─ valid payment ────> PAID
            ├─ re-simulation fails ─> REJECTED_AFTER_PAYMENT ─> REFUND_PENDING
            └─ accepted ────────────> EXECUTING
                 ├─ verified success before deadline ─> SETTLED
                 ├─ verified revert ──────────────────> FAILED ─> REFUND_PENDING
                 ├─ deadline missed ──────────────────> LATE ───> REFUND_PENDING
                 └─ timeout/not_found ────────────────> UNCERTAIN

REFUND_PENDING
  ├─ verified refund receipt ─> REFUNDED
  └─ refund timeout ──────────> REFUND_UNCERTAIN
```

**Critical rule:** `UNCERTAIN` is never retried as a new broadcast. A transaction that timed out in KeeperHub may still land later. The reconciliation worker continues checking the original hash/execution until finality or manual resolution.

---

## 10. Idempotency and replay safety

The idempotency key is derived from economic intent, not from an attempt:

```text
canonicalIntent =
  adapterVersion
  | jobId
  | chainId
  | targetAddress
  | functionSelector
  | canonicalArgumentsHash
  | valueWei
  | deadlineBucket

idempotencyKey = sha256(utf8(canonicalIntent))
```

Canonicalization rules:

- Numeric chain ID in decimal form
- Lowercase addresses
- Integer atomic-unit amounts; never JavaScript floating point
- ABI arguments encoded deterministically
- `%` and `|` escaped inside opaque identifiers
- Deadline bucket included so recurring work does not collide
- Exact broadcast body persisted before the first attempt

Responses are handled as follows:

| Response | Action |
|---|---|
| Original success | Persist execution ID and poll |
| `idempotentReplay: true` | Reuse original result; do not classify as a new attempt |
| `409 idempotency_in_progress` | Wait and poll original intent |
| `409 idempotency_conflict` | Fail closed; raise a reconciliation incident |
| `timeout` / `not_found` receipt | Enter `UNCERTAIN`; never blindly re-broadcast |

---

## 11. Verification and settlement

Basis does not treat a returned transaction hash as proof.

Success requires:

```text
execution.status == "completed"
AND receipts.length > 0
AND every receipt.verified == true
AND every receipt.receiptStatus == "success"
AND completion timestamp <= contractual deadline
AND adapter-specific postcondition == true
```

Adapter-specific postconditions include:

- Expected event emitted with matching indexed values
- Expected state transition observed by independent RPC
- Expected beneficiary balance increase
- Expected allowance equals zero
- Expected settlement/finalization flag set

KeeperHub's receipt is one ledger. The public chain queried independently is the second. Their transaction hash and execution ID are join keys.

---

## 12. Refund policy

### Refundable

- KeeperHub cannot execute after payment because re-simulation fails.
- Verified transaction reverts.
- Basis misses its service deadline.
- Basis rejects the paid order because its own quote validation fails.

### Not automatically refundable

- Buyer supplied a semantically valid job that produced the intended onchain result but later became economically undesirable.
- Market prices moved after successful execution.
- The protocol behaved according to its contract but contrary to the buyer's strategy.
- The order is in `UNCERTAIN`; refund waits until double-execution risk is resolved.

Refunds are USDC transfers through KeeperHub Direct Execution. They use a separate deterministic idempotency key derived from the original quote ID:

```text
sha256("refund" | quoteId | paymentTxHash | refundAmountAtomic)
```

The refund receipt is appended to the same audit chain.

---

## 13. The Hermes operator

Hermes is the **read-only operating analyst**, not the executor.

### 13.1 Responsibilities

#### A. Natural-language intake

Converts:

```text
"Settle epoch 184 on Base within five minutes and use private routing if available."
```

into a proposal:

```json
{
  "jobType": "protocol.settle",
  "chainId": 8453,
  "adapter": "example-protocol-v1",
  "params": { "epoch": "184" },
  "deadlineTier": "5m",
  "privateRouting": true
}
```

The deterministic core validates it. Hermes cannot create an unlisted job type or bypass adapter policy.

#### B. Failure classification

Reads normalized evidence and labels failure causes:

- `insufficient-balance`
- `stale-premise`
- `slippage`
- `nonce-contention`
- `gas-limit-shortfall`
- `congestion`
- `contract-revert`
- `rpc-failure`
- `keeperhub-timeout`
- `unknown`

The label is evidence for analysis, not authorization to retry.

#### C. Pricing-prior feedback

The deterministic analytics job computes retry and failure rates from the labeled history. Hermes never chooses the premium directly.

```text
Hermes label
  → ledger entry
  → deterministic grouped failure statistics
  → versioned retryPremiumBps
  → pure pricing function
```

#### D. Reconciliation watchdog

Compares:

- Basis SQLite records
- Hash-chained JSONL entries
- KeeperHub executions and analytics
- Independently fetched chain receipts

It reports divergence but cannot repair records or move funds.

#### E. Scheduled operations digest

Posts to Telegram/Discord:

- Jobs quoted / paid / settled / refunded
- Gross revenue
- Market gas cost
- Realized cost
- Realized margin
- Deadline hit rate
- Pricing error P50/P95
- Uncertain executions
- Ledger reconciliation anomalies

### 13.2 Explicitly forbidden operator actions

Hermes cannot:

- Broadcast a transaction
- Issue a refund
- Change quote arithmetic
- Change a job adapter or allowlist
- Mark an execution successful
- Reconcile an uncertain transaction by guessing
- Modify or delete audit history

`KEEPERHUB_ENABLE_WRITES` remains unset for the Hermes profile.

---

## 14. Technical stack

| Layer | Technology | Decision rationale |
|---|---|---|
| Runtime | Node.js 22, TypeScript, ESM | Native to KeeperHub SDK/wallet and x402 ecosystem |
| Chain client | viem | `eth_feeHistory`, ABI handling, independent receipt reads, typed chain access |
| HTTP API | Fastify + TypeBox/JSON Schema | Strict validation and generated OpenAPI |
| Decimal arithmetic | decimal.js or equivalent | Never use floating-point for money |
| Primary store | SQLite with `better-sqlite3`, WAL mode | Zero-ops, queryable, portable artifact |
| Audit store | Append-only JSONL + SHA-256 chain | Tamper-evident public evidence |
| Seller MCP | `@modelcontextprotocol/sdk` | Typed `quote` and `order` agent tools |
| KeeperHub | Official SDK where complete; direct REST where required | Preserve exact API/status semantics |
| Buyer wallet | `@keeperhub/wallet` | x402/MPP payment and safety policy |
| Operator | Hermes + `keeperhub-hermes-plugin` in read-only mode | Intake, triage, scheduling, reconciliation |
| Buyer demo | Claude Code + per-workflow KeeperHub MCP | Clean third-party buyer flow |
| Dashboard | Vanilla browser ESM + CSS | No build step; portable clean-clone demo |
| Tests | Node built-in test runner | Fast, zero framework dependency |
| Deployment | Railway with persistent volume | One long-running API/worker and simple public deployment |
| Chains | Base, Ethereum, Sepolia, Base Sepolia | Mainnet proof plus cheap test evidence |

### 14.1 Deliberately excluded

- No ORM
- No Redis in v1
- No React build pipeline
- No Docker Compose requirement
- No LLM in pricing, execution, settlement, verification, or refund decisions
- No arbitrary contract-call adapter in the default catalog

---

## 15. Repository structure

```text
basis/
├── src/
│   ├── api/
│   │   ├── server.ts
│   │   ├── schemas.ts
│   │   └── routes/
│   │       ├── quote.ts
│   │       ├── order.ts
│   │       ├── jobs.ts
│   │       ├── executions.ts
│   │       └── metrics.ts
│   ├── quoter/
│   │   ├── fee-history.ts
│   │   ├── fx.ts
│   │   ├── simulate.ts
│   │   ├── price.ts
│   │   ├── tiers.ts
│   │   └── quote.ts
│   ├── executor/
│   │   ├── idempotency.ts
│   │   ├── execute.ts
│   │   ├── poll.ts
│   │   ├── verify.ts
│   │   ├── settle.ts
│   │   ├── refund.ts
│   │   └── state-machine.ts
│   ├── adapters/
│   │   ├── adapter.ts
│   │   ├── registry.ts
│   │   ├── erc20-transfer.ts
│   │   ├── weth-wrap.ts
│   │   ├── protocol-settle.ts
│   │   └── aave-repay-for.ts
│   ├── keeperhub/
│   │   ├── client.ts
│   │   ├── simulation.ts
│   │   ├── direct-execution.ts
│   │   ├── receipts.ts
│   │   ├── analytics.ts
│   │   └── errors.ts
│   ├── rails/
│   │   ├── payment-rail.ts
│   │   ├── keeperhub-marketplace.ts
│   │   └── direct-x402.ts
│   ├── ledger/
│   │   ├── database.ts
│   │   ├── schema.sql
│   │   ├── events.ts
│   │   ├── audit-chain.ts
│   │   ├── reconcile.ts
│   │   └── export.ts
│   ├── mcp/
│   │   ├── server.ts
│   │   └── tools.ts
│   └── config/
│       ├── env.ts
│       ├── chains.ts
│       └── policy.ts
├── operator/
│   ├── hermes-plugin/
│   ├── prompts/
│   └── schedules/
├── sdk/
│   └── basis-sdk/
├── storefront/
│   ├── workflows/
│   └── provision.ts
├── dashboard/
│   ├── index.html
│   ├── app.mjs
│   ├── style.css
│   └── lib/audit-chain.mjs
├── backtest/
│   ├── collect-fees.ts
│   ├── replay.ts
│   └── report.ts
├── chaos/
│   ├── scenarios.ts
│   └── run.ts
├── test/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   └── fixtures/
├── evidence/
│   ├── transactions.json
│   ├── keeperhub-executions.json
│   ├── backtest-report.json
│   └── demo-book.jsonl
├── docs/
│   ├── FAILURE-MODES.md
│   ├── THREAT-MODEL.md
│   ├── PRICING-MODEL.md
│   ├── BOUNTY-DYNAMIC-PRICING.md
│   └── DEMO-SCRIPT.md
├── book.jsonl
├── book.sqlite
├── package.json
└── README.md
```

---

## 16. Ledger design

### 16.1 SQLite tables

```text
quotes
orders
executions
receipts
payments
refunds
fee_samples
fx_samples
pricing_models
failure_labels
reconciliation_runs
audit_events
```

### 16.2 Audit events

Every consequential transition appends:

```json
{
  "seq": 42,
  "timestamp": "2026-08-10T12:00:01.120Z",
  "type": "EXECUTION_VERIFIED",
  "entityId": "order_01J...",
  "payload": {
    "quoteId": "q_01J...",
    "keeperHubExecutionId": "direct_123",
    "transactionHash": "0x...",
    "receiptStatus": "success",
    "gasUsed": "68115",
    "gasUsedWei": "21000000000000",
    "deadlineHit": true
  },
  "prevHash": "0x...",
  "hash": "0x..."
}
```

Hash:

```text
SHA-256(canonicalJSON(seq, timestamp, type, entityId, payload, prevHash))
```

The browser imports the same verifier logic or a generated byte-identical ESM artifact. The dashboard includes:

- Verify full chain
- Report first broken sequence
- Simulate tampering on an in-memory copy
- Cross-link execution ID and transaction hash

The hash chain does not prevent a fully privileged attacker from replacing and re-chaining the entire file. Independent KeeperHub records and public-chain receipts provide external anchors. This limitation must be stated plainly.

---

## 17. Public dashboard: the open book

The dashboard is the strongest visual proof, not decorative UI.

### Required panels

1. **Live quote**
   - Job type
   - Deadline tier
   - Gas estimate
   - Protected gas price
   - ETH/USD
   - Retry premium
   - Raw quote and payment tier

2. **Execution tape**
   - Order
   - KeeperHub execution ID
   - Transaction link
   - Deadline
   - Completion latency
   - Verified receipt status

3. **The book**
   - Gross revenue
   - Marketplace fees
   - Market gas cost
   - Realized gas cost
   - Refunds
   - Realized margin

4. **Reliability**
   - Deadline hit rate
   - Success rate
   - Refund rate
   - Uncertain count
   - Retry count by cause

5. **Pricing quality**
   - Quote error P50/P95
   - Quoted gas price vs actual effective gas price
   - Margin distribution by deadline tier
   - Backtest vs live results clearly separated

6. **Audit verification**
   - Hash-chain status
   - Record count
   - Last hash
   - KeeperHub reconciliation status

### Accounting distinction

The dashboard must separate:

- **Market gas cost:** what the transaction would cost at the observed effective gas price
- **Realized Basis cost:** actual funds or sponsorship credits consumed

Sponsored execution must never be presented as if Basis paid ETH it did not pay.

---

## 18. Evidence strategy

### 18.1 Live evidence

- At least one verified **Ethereum or Base mainnet** job through KeeperHub
- Multiple Base mainnet jobs if affordable
- 100+ testnet benchmark jobs for state-machine and reliability evidence
- At least one refund transaction through KeeperHub
- At least one deliberate re-simulation rejection after payment
- At least one idempotent replay demonstration
- At least one induced uncertain/timeout scenario handled without double execution, if safely reproducible

### 18.2 Historical backtest

Use 30 days of real `eth_feeHistory` data to replay the pricing model across thousands of historical blocks.

Report:

- Deadline-tier coverage rate
- Price protection success rate
- Underpricing frequency
- Overpricing P50/P95
- Simulated margin distribution
- Sensitivity to retry premium

**Never mix backtest and live metrics.** The dashboard labels them separately:

```text
LIVE EXECUTION EVIDENCE
HISTORICAL PRICING BACKTEST
```

### 18.3 Clean-clone evidence

A stranger with no secrets must be able to run:

```bash
npm ci
npm test
npm run dashboard
npm run verify:book
npm run backtest:replay
```

The dashboard falls back to committed real captured evidence when no live service is configured.

---

## 19. Testing strategy

### Unit tests

- Pure price function and boundary tiers
- Decimal/atomic-unit conversion
- Fee percentile selection
- Quote signing and expiry
- Canonical job hashing
- Idempotency derivation
- State-machine transition table
- Audit-chain append and verification
- Failure classification schema validation

### Contract tests

- KeeperHub simulation response shapes
- Would-revert 400 handling
- Underfunded sender handling
- `idempotentReplay` recognition
- `idempotency_in_progress` and conflict handling
- Receipt status variants
- `X-Poll-Interval-Hint`
- Sponsored execution fields
- Marketplace 402 challenge parsing

### Integration tests

- Quote → pay → execute → verify → settle
- Quote → expire
- Pay → re-simulation fail → refund
- Execute → verified revert → refund
- Execute → timeout → uncertain, no rebroadcast
- Reconciliation between Basis, KeeperHub, and independent RPC

### Chaos scenarios

- RPC delay and partial outage
- Stale Chainlink sample
- Sudden fee jump between quote and broadcast
- Duplicate order delivery
- Worker crash after broadcast but before persistence
- Conflicting idempotency body
- Corrupted local audit record
- KeeperHub 429 rate limit
- Payment rail `CHAIN_MISMATCH`

The test suite must not require network access by default. Live tests use an explicit flag.

---

## 20. Payment-rail abstraction

The primary rail is KeeperHub's marketplace payment path.

```ts
interface PaymentRail {
  verifyPaidOrder(input: PaidOrderInput): Promise<VerifiedPayment>;
  getPaymentStatus(paymentId: string): Promise<PaymentStatus>;
  refund(input: RefundInput): Promise<RefundResult>;
}
```

Implementations:

1. `KeeperHubMarketplaceRail` — primary, x402/MPP through KeeperHub.
2. `DirectX402Rail` — isolated fallback for evidence if the observed first-party signer `CHAIN_MISMATCH` remains unresolved.

Rules:

- The fallback never replaces KeeperHub as the **execution layer**.
- The submission must state exactly which payment path produced each receipt.
- No simulated payment may be described as settled.
- If the KeeperHub rail is broken, that becomes a documented product finding and bounty contribution, not something hidden in the demo.

---

## 21. Deployment

### Chosen host: Railway

One long-running Node service provides:

- Fastify API
- Quote service
- Execution worker
- Reconciliation scheduler
- Static dashboard

A persistent volume stores SQLite and JSONL. Daily encrypted backups export to object storage or a repository evidence artifact.

Hermes runs as a separate process/profile with a read-only KeeperHub credential and Basis API read access.

### Environment separation

| Environment | Chains | Purpose |
|---|---|---|
| `local` | Fork/fixtures | Development and deterministic tests |
| `testnet` | Sepolia / Base Sepolia | Volume, failures, refund tests |
| `production` | Base / Ethereum | Public proof and real marketplace calls |

Write credentials are never shared across environments.

---

## 22. Build plan

### Phase 0 — hard-gate proof

- Create and verify KeeperHub `kh_` organization key
- Resolve organization wallet
- Fund testnet wallet
- Simulate transfer
- Execute with stable idempotency key
- Poll status
- Save a receipt where `verified == true`
- Test one paid marketplace call immediately to resolve `CHAIN_MISMATCH` risk

### Phase 1 — deterministic core

- Schemas and adapter registry
- Fee-history collection
- Chainlink FX read
- Pure price function
- Signed expiring quote
- SQLite schema and audit chain

### Phase 2 — execution contract

- Payment/order validation
- Re-simulation
- Idempotent KeeperHub execution
- Poll-hint-aware status worker
- Receipt and adapter-postcondition verification
- Refund state machine

### Phase 3 — storefront and buyer

- `basis-quote`
- Four fixed order tiers
- Per-workflow MCP exposure
- Buyer SDK
- Clean Claude Code purchase flow

### Phase 4 — proof

- 100+ testnet jobs
- Mainnet Mode 1 permissionless job
- Refund proof
- Historical fee backtest
- Open-book dashboard
- Evidence export

### Phase 5 — operator and bounty

- Read-only Hermes operator
- Failure triage
- Reconciliation watchdog
- Telegram digest
- Dynamic-price proposal and starter template

### Scope-cut order

If time becomes constrained, remove in this order:

1. MPP/Tempo
2. Swap/private-routing showcase
3. Aave value-bearing adapter
4. Telegram digest
5. Buyer npm package (keep MCP and HTTP)

Never remove:

- Quote
- Paid order
- KeeperHub execution
- Independently verified receipt
- Deadline accounting
- Refund path
- Open book

---

## 23. Demo script

### Five-minute finalist demo

**0:00–0:35 — The market gap**  
Show the reproducible marketplace census: paid listings are fixed-price and overwhelmingly sell information.

**0:35–1:00 — The proposition**  
"Tell Basis what should execute and by when. Basis quotes a fixed fee and takes the gas risk."

**1:00–1:45 — Quote live**  
Submit the same job with `1h`, `5m`, and `next-block`. Show price changes and the exact gas/FX/risk breakdown. Change nothing except the deadline.

**1:45–3:00 — Buy and execute**  
From a clean buyer agent:

1. Discover `basis-quote` through the typed MCP server.
2. Request a quote.
3. Pay through the KeeperHub agentic wallet.
4. Basis re-simulates and executes through KeeperHub.
5. Open the mainnet explorer transaction.
6. Show KeeperHub execution ID and independently verified receipt.

**3:00–4:10 — Open the book**  
Show live revenue, market cost, realized cost, margin, deadline hit rate, and pricing error. Clearly identify live vs historical data.

**4:10–4:35 — Failure is a product behavior**  
Show a paid job rejected by re-simulation and the verified KeeperHub refund transaction.

**4:35–5:00 — Sponsor ask**  
"This tier ladder proves execution can be sold. Native `price.mode: dynamic` removes the ladder. Here is the proposal and reference implementation."

### Audience participation version

Give a judge the per-workflow MCP installation line and let them request a low-cost Base job from their own agent. This is optional; the prepared demo remains deterministic and does not depend on audience setup.

---

## 24. Judging alignment

| Criterion | Basis evidence |
|---|---|
| Executes onchain through KeeperHub | Every paid order ends in a KeeperHub execution or KeeperHub refund; mainnet proof included |
| KeeperHub surface usage | Marketplace, MCP, x402, optional MPP, workflow builder/API, Direct Execution, simulation, idempotency, receipt status, analytics, audit trail, gas sponsorship/private routing when available |
| Reliability and observability | Explicit state machine, no blind retries, deadline accounting, refund behavior, independent receipts, reconciliation, pricing error and hit-rate metrics |
| Originality and usefulness | Introduces the missing execution-supply economics rather than another decision agent |
| Integration quality and DX | Typed job catalog, strict schemas, per-workflow MCP, clean-clone evidence, SDK, no-secret demo dashboard |
| Onboarding bounty | Dynamic-price protocol proposal, starter template, reproducible marketplace analysis, first-execution guidance |

---

## 25. Competitive positioning

### Versus execution SRE

Execution SRE repairs the owner's failed KeeperHub workflows. Basis sells execution to external agents and prices the cost of reliability. One improves operations; the other creates marketplace supply and revenue.

### Versus Outcome / Assay / receipt verifiers

They answer whether execution evidence is valid. Basis answers what guaranteed execution should cost, then uses receipt verification as part of settlement. Verification is necessary infrastructure inside Basis, not the product category.

### Versus KeeperTender

KeeperTender is a demand-side router choosing among existing information suppliers. Basis is the supply side creating an execution product that barely exists. KeeperTender's final write records a selection; Basis's write is the service purchased by the buyer.

### Versus wallet guardians and Aave bots

Those agents decide and act for one use case. Basis is horizontal execution infrastructure they could call after making their decision.

---

## 26. Threat model and major risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Payment rail returns `CHAIN_MISMATCH` | Cannot prove paid KeeperHub order | Test immediately; isolate rail; document fallback honestly; submit bug/proposal |
| Gas jumps beyond quote protection | Negative margin | Deadline percentiles, quote expiry, capped exposure, backtest, inventory limit |
| Transaction lands after timeout | Double execution/refund risk | `UNCERTAIN` state; no re-broadcast; reconcile original execution |
| Quote tampering/replay | Wrong tier or duplicated order | Signed quote, expiry, canonical job hash, consumed-quote constraint |
| LLM produces unsafe intent | Dangerous job proposal | Typed adapter allowlist; deterministic validation; read-only operator |
| Malicious contract/ABI | Fund loss or unexpected call | Verified targets, pinned ABI/code hash, no arbitrary default adapter |
| Buyer principal exposure | Trust/custody problem | Mode 1 is permissionless and custody-free; Mode 2 requires a cryptographically bounded smart-account intent and is optional |
| Sponsorship distorts profit | Misleading P&L | Separate market and realized cost |
| Fixed tiers create overpayment | Poor buyer economics | Expose rounding; add more tiers only when justified; dynamic-price proposal |
| Mainnet proof too expensive | Weak evidence | Base mainnet primary; one Ethereum proof if sponsorship/budget permits |
| Marketplace listing requires UI | Incomplete automation claim | List manually; document limitation; never overclaim |
| Audit file can be fully replaced | False tamper-proof claim | Call it tamper-evident; cross-anchor with KeeperHub and chain records |

### Exposure limits

- Maximum active underwriting per chain
- Maximum quote lifetime
- Maximum gas estimate per adapter
- Maximum total daily refunds
- Maximum value allowance for value-bearing jobs
- Circuit breaker when fee distribution exceeds configured bounds
- Circuit breaker after repeated KeeperHub failures
- No new orders while reconciliation reports unresolved accounting divergence

---

## 27. Success criteria

### Submission minimum

- Public source repository
- Demo video
- At least one linked transaction executed through KeeperHub
- Live or clean-clone dashboard
- Reproducible setup instructions

### Basis product acceptance

- A supported job can be quoted reproducibly.
- Shorter deadline produces explainably different protection and price.
- A buyer can pay for a quote-bound order.
- The exact job re-simulates before execution.
- KeeperHub executes with a stable idempotency key.
- Success is based on verified receipt plus adapter postcondition.
- A missed/rejected order produces a verified refund.
- The ledger calculates revenue, costs, margin, deadline performance, and pricing error.
- The operator cannot move funds.
- A clean clone can verify the committed evidence without secrets.

### First-place evidence target

- 1+ mainnet Mode 1 permissionless KeeperHub executions
- 100+ testnet executions
- 1+ real paid x402/MPP marketplace order, or a fully evidenced KeeperHub payment-rail defect with working compliant fallback
- 1+ verified KeeperHub refund
- 30-day historical gas backtest
- Published live-vs-backtest metrics
- Read-only Hermes operator with reconciliation report
- Dynamic-pricing bounty proposal or PR

---

## 28. Messaging rules

### Say

- "Basis underwrites gas and deadline risk."
- "The buyer gets price certainty."
- "Basis's transaction is the purchased product."
- "The operator is read-only."
- "Receipt verification and postconditions determine truth."
- "Live and backtested evidence are separated."
- "The service fee is refunded when Basis misses its promise."

### Do not say

- "Guaranteed transaction" without defining the deadline and refund remedy.
- "Tamper-proof ledger"—use **tamper-evident**.
- "Trustless" for allowance-based jobs.
- "KeeperHub paid the gas" unless `sponsored: true` is evidenced.
- "Marketplace execution" when a path returned unsigned calldata.
- "Autonomous payment succeeded" if settlement was simulated.
- "AI pricing"—the price is deterministic.

---

## 29. Final product narrative

KeeperHub solves the technical last mile: signing, gas handling, retries, private routing, and receipts. But a marketplace also needs an economic last mile. Sellers cannot offer serious execution when they cannot price the variable cost of delivering it.

Basis completes that market:

```text
Agent decides
  → Basis quotes
  → Buyer pays
  → KeeperHub executes
  → Chain proves
  → Basis settles the book
```

The product is not another agent that thinks. It is the counterparty agents can hire when thinking is finished.

> **Agents decide. Basis quotes. KeeperHub lands. The chain settles the argument.**

---

## Sources and research artifacts

- [Hackathon detail page](https://dorahacks.io/hackathon/agents-onchain/detail)
- [Hackathon tracks](https://dorahacks.io/hackathon/agents-onchain/tracks)
- [KeeperHub documentation](https://docs.keeperhub.com/)
- [KeeperHub MCP server documentation](https://docs.keeperhub.com/ai-tools/mcp-server)
- [KeeperHub agentic wallet documentation](https://docs.keeperhub.com/ai-tools/agentic-wallet)
- [KeeperHub marketplace documentation](https://docs.keeperhub.com/workflows/marketplace)
- [KeeperHub Direct Execution API](https://docs.keeperhub.com/api/direct-execution)
- [KeeperHub Hermes plugin](https://github.com/KeeperHub/hermes-plugin)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- Local marketplace snapshot: `research/keeperhub-openapi-2026-08-07.json`
- Strategy analysis: `agents-onchain-strategy.md`
- KeeperHub technical primer: `keeperhub-primer.md`

Research content from web sources was paraphrased and synthesized rather than reproduced verbatim.
