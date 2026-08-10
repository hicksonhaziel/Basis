# Refund policy and operations

## Policy `basis-refund-v1-base-usdc`

New quotes cryptographically bind the refund policy ID, normalized `refundRecipient`, Base chain ID `8453`, canonical Circle-issued Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, six-decimal atomic amount, gross refundable USD amount, and Marketplace payment tier. Legacy quotes lacking these signed fields are not compatible with v1 and are rejected at paid ingress. The token address was verified against Circle's authoritative USDC contract-address table on 2026-08-10.

The authenticated private tier is the sole amount authority: t1 refunds 0.01 USDC (10,000 atomic units), t2 0.05 (50,000), t3 0.25 (250,000), and t4 1.00 (1,000,000). Callers cannot choose the chain, token, amount, sender, function, calldata, or alter the signed recipient. The internal transfer path is not an HTTP route or public `erc20.transfer` adapter.

## Eligibility

A paid order becomes eligible after atomic acceptance when: re-simulation or the signed intent definitively fails before broadcast; a verified receipt reverted or adapter postconditions definitively failed; an internal pre-broadcast Basis failure occurs; or a deadline-backed execution definitively fails or succeeds after its contractual deadline. `next-block`, `5m`, and `1h` are deadline-backed. `best-effort` has a four-hour scheduling horizon but no timing refund right; definitive execution failures remain eligible.

Rejected/unpaid input, failures before atomic paid acceptance, on-time verified success, buyer preference changes, commercially undesirable but valid protocol behavior, gas, transaction value, and keeper-action assets are not refundable. `UNCERTAIN`, timeout/not_found, RPC disagreement, and possibly broadcast transactions are not immediately eligible. Execution uncertainty must resolve first. Refund submission ambiguity becomes `REFUND_UNCERTAIN`; reconciliation checks only the original KeeperHub execution and never rotates the key or blindly rebroadcasts.

## Lifecycle and proof

Eligibility creates one durable record per order/policy before network calls. The enforced path is `REFUND_PENDING → REFUND_SUBMITTING → REFUND_VERIFYING → REFUNDED`, with `REFUND_UNCERTAIN` for ambiguous submission/verification and `REFUND_FAILED` only for proven pre-broadcast failure or definitive revert. Restart after possible submission never broadcasts again.

`REFUNDED` requires a verified successful KeeperHub receipt, the same transaction from independent Base RPC, a confirmed successful receipt, and exactly one canonical USDC `Transfer` from the sender resolved in KeeperHub simulation to the signed recipient for the exact tier amount. KeeperHub `completed` alone is insufficient. Smart-account/sponsored routing is handled by validating the event's `from`, not assuming the outer transaction sender.

## Economics

Basis refunds the customer's full gross service fee even though KeeperHub retains 30%. For t3: customer paid $0.250, KeeperHub fee $0.075, Basis net revenue $0.175, refund $0.250, realized P&L before refund gas -$0.075. The ledger records gross payment, Marketplace fee, net revenue, gross refund, refund gas when available, and realized P&L; refunded work is never represented as zero-cost or full-margin. Refund gas and keeper-action gas/assets are never refunded.

## Settlement boundary

KeeperHub does not inject x402/MPP payer identity, payment transaction hash, or settlement receipt into workflow input. Basis records tier-workflow authorization and `detailedSettlementMetadataAvailable: false`; the callback is not described as an onchain receipt. The signed requester-selected `refundRecipient` can therefore differ from the unavailable Marketplace payer.

## Deployment

Broadcasting defaults off with `BASIS_REFUNDS_ENABLED=false`. Eligible records remain `REFUND_PENDING` and reconciliation reports them while disabled. Enabling requires the exact policy ID and canonical USDC address, explicit Base RPC, confirmed KeeperHub wallet, API key, and independent confirmation configuration. Fund that KeeperHub wallet with sufficient Base USDC for gross refunds and ETH/sponsorship for gas.

No force-refunded endpoint exists. Operators may only resume reconciliation of an existing obligation. Mainnet testing requires separate deployment/funding and explicit approval: paid t1 call → controlled eligible failure → exactly 0.01 Base USDC → independently verified Transfer. No live refund was sent during Phase 5. Marketplace workflows remain unprovisioned and unpublished.
