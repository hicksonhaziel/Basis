# Basis security boundary

Basis runtime is deterministic and requires no model provider. Pricing, adapter selection, simulation comparison, order admission, state transitions, KeeperHub Direct Execution, independent receipt verification, reconciliation, and reporting use explicit TypeScript rules.

## Paid Marketplace callback ingress

The four paid wrappers use separate environment-only bearer credentials: `BASIS_ORDER_T1_SECRET` through `BASIS_ORDER_T4_SECRET`. Each must contain at least 32 random bytes and must be distinct. KeeperHub supplies the applicable credential from that tier's private Webhook action; it is not Marketplace input, output, or persisted data. The backend derives the tier only from the timing-safe credential match and rejects legacy payment/source headers.

The callback body contains only `quoteId`. Contract, calldata, ABI, function, arguments, chain, native value, payment tier, payment hash, and refund recipient cannot be supplied or overridden by the callback. The signed quote is the authority for all of those execution fields.

Current KeeperHub code verifies x402/MPP before the paid call and internally records protocol, payment chain, amount, workflow execution ID, credential hash, and payer when recoverable. It passes only the caller body into the workflow graph. The Webhook action therefore receives none of that settlement metadata, and KeeperHub exposes no authenticated seller API to query a payment by workflow execution ID. Basis records `MARKETPLACE_PAYMENT_AUTHORIZED`, `AUTHENTICATED_WORKFLOW_CALLBACK`, the authenticated tier, and `NOT_EXPOSED_TO_WORKFLOW`; it does not manufacture a transaction hash, receipt, or payer identity.

KeeperHub distinguishes paid Marketplace calls from owner/manual runs internally, but that marker is not exposed to the graph. Consequently the callback cannot independently prove that a wrapper was not owner-triggered. Operators must not manually execute paid wrapper workflows. This limitation must be resolved with KeeperHub-exposed payment context before refund automation relies on payer identity.

## Refund recipient

Every paid quote request requires a valid EVM `refundRecipient`. Basis normalizes it to lowercase and includes it with the full fixed Base-USDC v1 policy in the signed canonical quote. The order callback cannot change it. It may differ from the Marketplace payer because KeeperHub does not expose payer identity to the workflow. Eligible obligations are created durably; broadcasting remains disabled by default.

## Asynchronous execution

Atomic quote consumption, order creation, exact intent persistence, and submission-record creation happen before the callback returns HTTP 202. Execution then continues asynchronously. Duplicate or concurrent callbacks return the original deterministic order ID and do not submit again. Buyers poll `basis-status`; KeeperHub's roughly 25-second read-workflow wait is not an execution deadline.

## Execution truth

`SUCCEEDED` still requires exact re-simulation, KeeperHub terminal completion with verified receipts, an independent successful RPC receipt, matching chain/hash/target/calldata/value, and all adapter postconditions. Timeouts and ambiguous evidence enter `UNCERTAIN`; reconciliation polls the original execution and never rebroadcasts from uncertainty.

## Phase 5 refund boundary

Refunds use one internal fixed rail: canonical six-decimal USDC on Base 8453, exact gross amount derived from the authenticated tier, and the HMAC-bound normalized recipient. The public API cannot select or invoke refund transfer parameters. Legacy quotes without the complete `basis-refund-v1-base-usdc` terms are rejected.

Broadcasting defaults disabled. A permanent obligation and exact request exist before network activity; one database uniqueness constraint and deterministic key survive KeeperHub's replay-window expiry. Ambiguous submissions are never automatically rebroadcast. `REFUNDED` requires verified KeeperHub evidence, independent Base RPC success and confirmation, and exactly one matching canonical `Transfer` event from the simulation-resolved sender. See `REFUNDS.md` for eligibility and operations.
