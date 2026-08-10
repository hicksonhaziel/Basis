# Basis

Basis produces deterministic, expiring execution quotes and submits policy-bounded calls through KeeperHub. SQLite is the authoritative ledger; a versioned SHA-256 JSONL audit chain is exported for independent verification.

## Requirements and clean install

- Node.js 22 or newer
- npm (the committed `package-lock.json` is authoritative)

```sh
git clone <repository-url> basis
cd basis
npm ci
npm run build
npm test
```

Copy `.env.example` to `.env.local` and replace placeholders. Never commit secrets. Start the API with:

```sh
node --env-file=.env.local --experimental-strip-types src/api/server.ts
```

## Security and pricing behavior

Quotes use `basis-canonical-json:v1` recursively and `hmac-sha256:v2`; the HMAC key remains private to Basis. Audit events use the same canonical JSON format and `sha256:v2`, binding sequence, predecessor, metadata, and every nested payload field.

Pricing includes KeeperHub's 30% marketplace fee by grossing up the seller-required execution cost, overhead, and margin. Basis does not charge retry or private-routing premiums because those services are not implemented. Quotes above the largest payment tier are rejected.

Production oracle reads fail closed on RPC/feed errors, stale or incomplete Chainlink rounds, stale independent references, and excessive divergence. `ALLOW_TEST_FX_FALLBACK=true` is accepted only outside production and requires `TEST_FX_FALLBACK_USD`; fallback provenance is included in the signed quote.

## Commands

```sh
npm run build                  # TypeScript check
npm test                       # Full test suite
npm run test:unit              # Unit tests
npm run verify:book -- path/to/audit.jsonl
npm run reconcile:report -- evidence/batch.jsonl
npm run backtest:replay        # Requires an RPC connection
```

`npm run verify:book` recomputes every event hash and checks exact sequence and `prevHash` continuity. The dashboard performs the same verification in the browser. See `docs/SECURITY.md` for trust boundaries and operational limitations.

## KeeperHub Marketplace storefront

Basis defines six read-only wrappers: `basis-quote`, four fixed-price `basis-order-t1` through `basis-order-t4` workflows, and `basis-status`. Set four distinct 32-byte-or-longer `BASIS_ORDER_T*_SECRET` values and `BASIS_PUBLIC_BASE_URL`; never commit them.

```sh
npm run marketplace:provision                 # read-only inventory + dry-run
npm run marketplace:provision -- --apply      # create/update privately and validate
npm run marketplace:provision -- --publish    # public listing; explicit approval only
```

Paid wrappers accept only `quoteId`; execution continues asynchronously and buyers poll status. KeeperHub does not expose payer/payment transaction metadata to workflow nodes, so Basis stores no fabricated payment hash or payer. New quotes bind a normalized `refundRecipient` and fixed `basis-refund-v1-base-usdc` gross-service-fee terms. Eligible obligations are durable, but broadcasting defaults off with `BASIS_REFUNDS_ENABLED=false`. See `docs/MARKETPLACE.md` for protocol behavior and `docs/REFUNDS.md` for exact eligibility, verification, economics, funding, and deployment controls.
