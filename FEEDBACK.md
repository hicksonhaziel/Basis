# KeeperHub product feedback

Basis was built as an execution seller, where cost and outcome proof are request-specific. The platform provided valuable primitives, but the integration also exposed gaps that matter for autonomous commerce.

## What worked well

### Direct Execution

Simulation, idempotent submission, execution polling, sponsored routing and receipt data form a strong foundation for policy-bounded execution. The API allowed Basis to keep commercial logic outside workflow graphs while using KeeperHub as the execution provider.

### Marketplace workflow model

Thin Manual-trigger → Webhook workflows are easy to provision, validate and list. Fixed-price USDC tiers provided a workable fallback for a service whose real price is dynamic.

### MCP discoverability

Marketplace-generated tools make workflows visible to agent clients without every seller operating a separate remote MCP transport.

## Highest-impact improvements

### 1. Native dynamic pricing

Execution cost changes with gas, urgency and risk. Add a quote-backed price mode with:

- seller quote endpoint
- currency and maximum buyer price
- quote ID and expiry fields
- seller authentication/signature metadata
- one-time quote consumption

The current four-tier workaround is safe but creates six listings for one product and introduces rounding.

### 2. Authenticated payment context for workflow nodes

The paid call route knows protocol, chain, amount, payer when recoverable, and workflow execution ID, but Webhook nodes receive only caller input. Expose a signed, read-only payment context containing:

- paid versus owner/manual invocation
- protocol and settlement chain
- amount and asset
- payer/refund identity when available
- Marketplace execution ID
- settlement proof or a retrievable proof reference

Without this, a seller callback cannot independently distinguish a paid Marketplace call from an owner run.

### 3. Seller payment lookup

Provide an authenticated endpoint to resolve payment/settlement evidence from a Marketplace workflow execution ID. Aggregate earnings are insufficient for per-order accounting, dispute handling and refund proof.

### 4. Dedicated MCP schema fidelity

Dedicated per-workflow MCP tools should derive their schema from the listing `inputSchema`, not only the Manual trigger. During integration, custom job fields could be dropped while an optional `type: "manual"` remained. The aggregate call path preserved inputs more reliably.

### 5. Long-running workflow semantics

Execution may exceed a synchronous read-workflow wait. First-class asynchronous tool results should include a stable operation ID, polling schema and terminal-state link rather than requiring each seller to create a separate status workflow.

### 6. Refund primitives

A paid Marketplace call should expose a platform-native refund operation tied to the original settlement. Seller-funded compensating transfers are economically and operationally different: the seller may refund the gross amount after Marketplace fees and must independently prove a second transaction.

## Security recommendations

- Preserve idempotency beyond a short replay window for financial operations.
- Make owner/manual invocation provenance explicit to workflow nodes.
- Keep payment credentials and signature hashes distinct from transaction hashes in API naming.
- Include receipt verification semantics and chain identity in machine-readable schemas.
- Support unlisting while preserving permanent slug history and buyer warnings.

## Summary

KeeperHub already supplies the difficult execution primitive. Native dynamic pricing, authenticated payment context, schema-faithful MCP tools and settlement-linked refunds would turn that primitive into a complete marketplace for execution services.
