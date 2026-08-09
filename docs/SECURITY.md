# Basis security boundary

Basis runtime is deterministic and requires no model provider. Pricing, adapter selection, simulation comparison, order admission, state transitions, KeeperHub submission, receipt verification, reconciliation, and reporting use explicit TypeScript rules.

## Private order ingress

`POST /orders` requires both:

- `Authorization: Bearer <ORDER_INGRESS_SECRET>`
- `x-basis-ingress-source: keeperhub-private-workflow`

The bearer secret authenticates a private workflow-to-backend call. The source marker is defense-in-depth routing metadata. **Neither header proves payment or contains settlement metadata.** Marketplace users must never control either header.

Orders currently enter `AUTHENTICATED_INGRESS`, not `PAID`. A future paid KeeperHub workflow must demonstrate that KeeperHub gates invocation before Basis may use `PAID` or `VERIFIED_MARKETPLACE_PAYMENT`. Basis does not manufacture payment hashes.

## Execution truth

`SUCCEEDED` requires all of the following:

1. Exact re-simulation of the signed canonical intent.
2. KeeperHub terminal completion with applicable verified successful receipts.
3. Independent RPC transaction and successful receipt.
4. Matching chain context, transaction hash, target, calldata, and native value.
5. Every adapter postcondition passing.

Timeouts and missing/ambiguous evidence enter `UNCERTAIN`. Reconciliation polls the original KeeperHub execution ID and never broadcasts again from `UNCERTAIN`.

## Optional future natural-language intake

The only reserved model boundary is plain language to an untrusted `JobProposal`. It is not implemented or enabled. Any future proposal must enter the same typed quote API and cannot access credentials, authorize payment, consume quotes, write the ledger, select unregistered adapters/contracts/chains, or trigger execution.
