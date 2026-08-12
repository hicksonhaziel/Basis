# Bounty Proposal: Native Dynamic Pricing for KeeperHub Marketplace

## Summary

KeeperHub's marketplace currently supports only fixed-price workflows. This works for information services (risk scores, yield data, analytics) where marginal cost is predictable. It fails for **execution services** where cost depends on gas prices, congestion, retries, and urgency.

This proposal introduces `price.mode: "dynamic"` — allowing sellers to quote a price at request time rather than fixing it at listing time.

## The Problem

From a reproducible census of KeeperHub's marketplace (August 7, 2026):
- **68 paid listings** — all use fixed pricing
- **0 execution services** with dynamic cost handling
- Execution sellers face an impossible choice:
  - Price high → overcharge buyers most of the time
  - Price low → lose money during gas spikes

The fixed-price model structurally discourages execution supply.

## Proposed Solution

Add a `dynamic` price mode to the marketplace payment schema:

```json
{
  "x-payment-info": {
    "price": {
      "mode": "dynamic",
      "quoteEndpoint": "/quote",
      "currency": "USD",
      "quoteIdField": "quoteId",
      "expiresAtField": "expiresAt",
      "maxPrice": "5.00"
    }
  }
}
```

### Flow

1. Buyer discovers workflow via MCP/marketplace
2. Buyer calls the `quoteEndpoint` with job parameters
3. Seller returns a signed, expiring quote with exact price
4. Buyer's wallet verifies price ≤ `maxPrice` (safety cap)
5. Payment settles at the quoted amount
6. Seller executes

### Quote Schema

```json
{
  "quoteId": "q_01J...",
  "priceUsd": "0.25",
  "expiresAt": "2026-08-10T12:00:30Z",
  "breakdown": {
    "gasEstimate": "65000",
    "protectedGasPrice": "22 gwei",
    "nativeAssetUsd": "3124.22",
    "riskPremium": "15%",
    "margin": "20%"
  },
  "signature": "0x..."
}
```

### Security

- Quotes are authenticated by the seller; native Marketplace support should use an asymmetric signature or platform-verifiable attestation
- Quotes expire and are single-use, preventing stale-price replay
- The buyer wallet enforces `maxPrice` before payment
- The seller revalidates the quote and canonical intent before execution

## Why This Matters

Without dynamic pricing:
- Execution services cannot exist safely on the marketplace
- Buyers overpay on average (sellers must price for worst-case)
- No incentive to build execution infrastructure on KeeperHub

With dynamic pricing:
- Sellers can quote real-time cost + margin
- Buyers pay fair market price
- Execution becomes a viable marketplace category
- KeeperHub earns fees on a new class of high-value transactions

## Reference Implementation

Basis demonstrates the workaround today using a **tier ladder**:
- `basis-quote` (free) → returns a signed quote
- `basis-order-t1` ($0.01) → executes if quote maps to this tier
- `basis-order-t2` ($0.05)
- `basis-order-t3` ($0.25)
- `basis-order-t4` ($1.00)

This works but is clunky. Native dynamic pricing removes the ladder entirely.

## Deliverables

1. This proposal document
2. Basis as a working proof-of-concept execution seller
3. 24+ verified testnet executions demonstrating the pricing model
4. Historical backtest showing pricing accuracy across 1000+ blocks
5. Open-source reference implementation of the quote/sign/verify flow

## Starter Template

For other execution sellers who want to adopt this pattern before native support ships:

```typescript
// 1. Seller: compute and sign a quote
const quote = {
  quoteId: crypto.randomUUID(),
  priceUsd: computePrice(gasEstimate, feePercentile, ethUsd),
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
};
quote.signature = sellerSign(canonicalize(quote), sellerPrivateKey);

// 2. Buyer: verify the seller identity, enforce its cap, then pay
if (verifySignature(canonicalize(quote), quote.signature, sellerPublicKey)
    && new Decimal(quote.priceUsd).lte(maxPrice)
    && new Date(quote.expiresAt) > new Date()) {
  await pay(quote.priceUsd);
  await callOrderEndpoint(quote.quoteId);
}

// 3. Seller: verify platform payment authority and consume once
if (await marketplacePaymentAuthorized(quote.quoteId) && !isConsumed(quote.quoteId)) {
  markConsumed(quote.quoteId);
  await executePersistedCanonicalIntent(quote.quoteId);
}
```

---

*Submitted by Basis — Execution, Priced.*
*GitHub: github.com/hicksonhaziel/Basis*
