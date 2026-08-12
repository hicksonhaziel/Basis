# Architecture

Basis is a deterministic execution-underwriting service. Buyer-facing MCP and Marketplace surfaces are thin interfaces; the Railway operator is the only stateful decision engine.

## System map

```text
Buyer agent
  ├─ Local Basis MCP: quote, status, evidence, catalog
  └─ KeeperHub Marketplace MCP: paid tier workflows
           │
           ▼
    KeeperHub read workflow
    Manual trigger → authenticated webhook
           │ quoteId only
           ▼
    Basis API and operator
    pricing · policy · state · reconciliation
           │
           ▼
    KeeperHub Direct Execution
           │
           ▼
    EVM chain + independent RPC
           │
           ▼
    SQLite ledger + hash-chained JSONL + dashboard
```

## Components

| Component | Responsibility | Trust boundary |
|---|---|---|
| Quoter | Fee history, Chainlink FX, simulation, pricing, expiry and quote authentication | Fails closed on stale or divergent production oracle data |
| Adapter registry | Selects target/function policy, validates parameters, sets gas/value limits and postconditions | Callers cannot provide arbitrary contracts or calldata |
| Executor | Atomic admission, exact re-simulation, preflight, KeeperHub submission and independent verification | Paid authority must originate from a tier credential |
| Reconciliation worker | Restart recovery, original-execution polling, deadline settlement and refund eligibility | Never blindly rebroadcasts uncertain work |
| Refund engine | Fixed Base-USDC obligation, deterministic request and independent Transfer verification | Disabled by default; no public refund-call route |
| Ledger | SQLite authority and append-only SHA-256 JSONL | Stores durable state before network side effects |
| Marketplace workflows | Public storefront, payment gate and webhook forwarding | No pricing or transaction logic in workflow graphs |
| Basis MCP | Quote/status/evidence/catalog convenience tools | Cannot authorize paid execution |

## Quote and order flow

1. A structured job is validated by a registered adapter.
2. KeeperHub simulation returns an execution estimate.
3. Basis reads recent fee history and native-asset/USD evidence.
4. The versioned pricing function computes cost, risk, Marketplace fee, overhead and target margin.
5. The amount rounds to the smallest sufficient fixed Marketplace tier.
6. Basis persists an expiring authenticated quote containing the complete canonical intent.
7. The buyer invokes the matching paid KeeperHub workflow with `quoteId` only.
8. Basis verifies tier credential, quote integrity, expiry, refund terms and one-time consumption.
9. The exact persisted request is re-simulated and preflighted immediately before submission.
10. Success requires KeeperHub evidence, an independent RPC receipt and adapter postconditions.

## Recovery invariant

Recovery does not reinterpret user input. It revalidates persisted adapter fields, rebuilds the call and simulation request, compares them with the canonical intent, re-simulates, applies the gas cap, runs final preflight, and submits only with the original idempotency key.

`UNCERTAIN` means the outcome may exist outside Basis. Reconciliation may poll an existing KeeperHub execution ID, but it cannot submit a replacement transaction.

## Execution truth

A KeeperHub `completed` response is necessary but insufficient. Basis independently checks:

- transaction and receipt hash agreement
- successful receipt status and intended chain
- target, calldata, native value and executor for direct routing
- adapter event/state postconditions
- historical receipt-block state when required

Sponsored smart-account routing is handled by adapter proof rather than assuming the outer transaction matches the inner call.

## Data and public reporting

SQLite is authoritative. The JSONL audit chain binds sequence, timestamp, predecessor, entity, event type and full payload using canonical JSON and SHA-256. The dashboard exposes a redacted static evidence package plus live aggregate metrics; it never serves the raw production ledger.

## Deployment

The Docker image runs one Fastify API, reconciliation loop and dashboard. `/data` is a persistent writable volume. The entrypoint validates volume access, assigns it to the unprivileged runtime user and then starts Node.

Environment and operational controls are documented in [.env.example](../.env.example), [Security](SECURITY.md), and [Refunds](REFUNDS.md).
