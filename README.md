<div align="center">

# Basis

### Execution, priced.

**Deterministic, deadline-aware onchain execution through KeeperHub.**

[Live dashboard](https://outstanding-motivation-production-c0ff.up.railway.app/) · [Submission brief](SUBMISSION.md) · [Architecture](docs/ARCHITECTURE.md) · [MCP guide](docs/MCP.md) · [Public evidence](docs/EVIDENCE.md)

![Node.js 22](https://img.shields.io/badge/Node.js-22-43853d?style=flat-square) ![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square) ![MCP](https://img.shields.io/badge/MCP-1.30-7c3aed?style=flat-square) ![Network](https://img.shields.io/badge/proof-Base_Sepolia-0052ff?style=flat-square)

</div>

Basis turns a structured keeper job into a signed, expiring quote, accepts the matching fixed-price Marketplace tier, re-simulates the exact intent, executes through KeeperHub, and independently verifies the result. Pricing, authorization, recovery, receipt checks, and refunds are deterministic TypeScript rules—no model participates in the execution path.

> [!IMPORTANT]
> **Truthful public status:** the service and dashboard are live; all six KeeperHub Marketplace workflows and their expected input fields are publicly visible; no paid Marketplace settlement, live refund, mainnet execution, or disclosed Phase 7 Morpho transaction is claimed. The committed benchmark is 24 sponsored Base Sepolia WETH executions and the backtest is a Basis-reported historical result.

## Why Basis

Execution sellers cannot safely use one fixed price when gas, urgency, and failure exposure change continuously. Basis computes a reproducible quote from simulation, fee history, native-asset FX, deadline policy, Marketplace fee, overhead, and target margin—then maps the result to one of four KeeperHub payment tiers.

| Property | Basis behavior |
|---|---|
| Deterministic quotes | Canonical JSON, versioned pricing, signed expiry and complete price breakdown |
| Bounded execution | Typed adapters choose the target, function, value, calldata policy and gas ceiling |
| No blind retries | Ambiguous submissions become `UNCERTAIN`; recovery polls the original execution only |
| Independent proof | KeeperHub receipt plus independent RPC receipt and adapter-specific postconditions |
| Durable accounting | SQLite authority plus an append-only, SHA-256 hash-chained JSONL audit log |
| Payment boundary | Paid orders enter only through tier-authenticated KeeperHub Marketplace workflows |

## Architecture

```text
Buyer agent
   │
   ├── Basis MCP ───────── quote · status · evidence · catalog
   │
   └── KeeperHub Marketplace MCP
          │  x402 / MPP gate + fixed-price tier
          ▼
      thin KeeperHub workflow
          │  authenticated webhook: quoteId only
          ▼
      Basis operator on Railway
          │  validate → re-simulate → preflight → persist
          ▼
      KeeperHub Direct Execution
          │
          ▼
      EVM chain → independent RPC verification → open book
```

The Marketplace graph contains no transaction logic. The stateful Basis operator owns pricing, policy, idempotency, verification, reconciliation, and refund eligibility. See [Architecture](docs/ARCHITECTURE.md) and [Security](docs/SECURITY.md).

## Live surfaces

- **Dashboard and API:** [public evidence console](https://outstanding-motivation-production-c0ff.up.railway.app/)
- **Health:** [`/health`](https://outstanding-motivation-production-c0ff.up.railway.app/health)
- **Metrics:** [`/metrics`](https://outstanding-motivation-production-c0ff.up.railway.app/metrics)
- **Redacted evidence:** [`/phase7-evidence.json`](https://outstanding-motivation-production-c0ff.up.railway.app/phase7-evidence.json)
- **Source:** [github.com/hicksonhaziel/Basis](https://github.com/hicksonhaziel/Basis)

## Quickstart

### Requirements

- Node.js 22+
- npm with the committed lockfile

```bash
git clone https://github.com/hicksonhaziel/Basis.git
cd Basis
npm ci
npm run build
npm test
```

Create local configuration without committing it:

```bash
cp .env.example .env.local
node --env-file=.env.local --experimental-strip-types src/api/server.ts
```

The API exposes `POST /quote`, `POST /orders`, `GET /orders/:id`, `GET /metrics`, `GET /health`, and the dashboard at `/`.

## MCP

Run the local stdio server against the hosted operator or your own deployment:

```bash
BASIS_PUBLIC_BASE_URL=https://your-basis-host.example npm run mcp
```

| Tool | Purpose | Side effect |
|---|---|---|
| `basis_quote` | Request a deterministic signed quote | Records a quote; never executes |
| `basis_status` | Read order, execution, verification and refund state | None |
| `basis_evidence` | Read the redacted evidence package | None |
| `basis_marketplace_catalog` | Discover the six KeeperHub tools and prices | None |

Paid execution is deliberately absent from the local MCP server. Buyer agents must call the paid KeeperHub Marketplace tool so Basis cannot bypass Marketplace payment authority. Setup examples are in [docs/MCP.md](docs/MCP.md).

## KeeperHub Marketplace

| Workflow | Price | Input | Result |
|---|---:|---|---|
| `basis-quote` | Free | Structured job request | Signed, expiring quote |
| `basis-order-t1` | $0.01 | `quoteId` | Accepted asynchronous order |
| `basis-order-t2` | $0.05 | `quoteId` | Accepted asynchronous order |
| `basis-order-t3` | $0.25 | `quoteId` | Accepted asynchronous order |
| `basis-order-t4` | $1.00 | `quoteId` | Accepted asynchronous order |
| `basis-status` | Free | `orderId` | Execution and verification state |

Each paid workflow accepts only `quoteId`; contract, calldata, value, recipient and tier come from the signed quote. Details and current platform limitations are documented in [docs/MARKETPLACE.md](docs/MARKETPLACE.md).

## Policy-bounded adapters

| Adapter | Boundary |
|---|---|
| `weth.wrap` | Chain-pinned WETH, positive amount, maximum `0.01 ETH`, exact `Deposit` proof |
| `weth.unwrap` | Chain-pinned WETH, positive amount, maximum `0.01 WETH`, exact `Withdrawal` proof |
| `erc20.transfer` | Disabled unless an exact chain/token/recipient/amount allowlist is configured |
| `morpho.accrue_interest` | One immutable Base Sepolia Morpho market, zero value, code-hash checks, 180k gas cap, exact raw event and historical-state proof |

Configured chains are Ethereum, Base, Sepolia, and Base Sepolia. Adapter policy determines which combinations are actually admissible.

## Execution lifecycle

```text
quote → authenticated ingress → exact re-simulation → pre-submit preflight
      → KeeperHub execution → independent verification → succeeded / late
                                              └────────→ uncertain / failed
```

A crash-recovered request must reproduce the persisted target, calldata, value, ABI call, simulation fields and idempotency key. `EXECUTING` is entered only after recovered preflight succeeds. Unknown submission outcomes are never automatically rebroadcast.

## Evidence, economics and limitations

The dashboard separates three provenance classes: public-chain facts, KeeperHub-reported facts, and Basis-local ledger facts. It also keeps live metrics separate from historical backtest data.

- **Committed benchmark:** 96 hash-chained events covering 24 sponsored Base Sepolia WETH benchmark executions.
- **Backtest:** 1,003 tested Base blocks; original RPC response and immutable block range were not retained, so results are labeled Basis-reported.
- **Morpho policy:** implemented and tested, but the repository does not disclose a matching Phase 7 transaction record.
- **Payments:** workflow publication is not evidence of a completed paid call.
- **Refunds:** durable policy exists, but broadcasting defaults off and no live refund is claimed.
- **Mainnet:** supported configuration is not a mainnet-execution claim.

Read [Public evidence](docs/EVIDENCE.md), [Refund policy](docs/REFUNDS.md), and [Dynamic pricing proposal](docs/BOUNTY-DYNAMIC-PRICING.md) before making commercial or proof claims.

## Commands

```bash
npm run build                              # TypeScript check
npm test                                   # complete test suite
npm run mcp                                # local stdio MCP server
npm run verify:book -- dashboard/evidence.jsonl
npm run reconcile:report -- evidence/batch.jsonl
npm run backtest:replay                    # live RPC required
npm run marketplace:provision             # inventory and dry-run
```

Marketplace mutation and refund broadcasting require explicit operator approval. Never commit `.env.local`, credentials, quote signatures, authorization headers, or private RPC URLs.

## Documentation

- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [MCP integration](docs/MCP.md)
- [KeeperHub Marketplace](docs/MARKETPLACE.md)
- [Security model](docs/SECURITY.md)
- [Refund policy and operations](docs/REFUNDS.md)
- [Public evidence index](docs/EVIDENCE.md)
- [Dynamic pricing bounty proposal](docs/BOUNTY-DYNAMIC-PRICING.md)
- [Demo script](docs/DEMO-SCRIPT.md)
- [Submission brief](SUBMISSION.md)
- [KeeperHub feedback](FEEDBACK.md)

## Scope

Basis is a hackathon proof of a production-oriented execution seller. It demonstrates deterministic underwriting, policy-bounded KeeperHub execution, independent verification, durable recovery, Marketplace storefronts, MCP access and a truthful public evidence surface. It is not an audited protocol, custody product, payment processor, or representation of completed mainnet commerce.
