# Basis submission brief

## One-line pitch

**Basis is a deterministic execution underwriter: agents receive deadline-aware quotes, pay the matching KeeperHub Marketplace tier, and receive independently verified policy-bounded execution.**

## Links

- Repository: https://github.com/hicksonhaziel/Basis
- Live dashboard: https://outstanding-motivation-production-c0ff.up.railway.app/
- Representative KeeperHub execution: https://sepolia.basescan.org/tx/0x34a4070605bf2e813fef81b25d1530798350d8b6ae9a45f183d5c3150e58b474
- Complete 24-transaction ledger: https://github.com/hicksonhaziel/Basis/blob/main/dashboard/evidence.jsonl
- Public evidence: https://outstanding-motivation-production-c0ff.up.railway.app/phase7-evidence.json
- Demo video: to be added after recording

The linked transaction is a sponsored Base Sepolia WETH benchmark executed through KeeperHub Direct Execution. It is not evidence of a paid Marketplace call, Morpho execution, refund, or mainnet execution.

## Problem

Fixed-price agent marketplaces work for predictable information services but fail for execution services. Gas, congestion, deadline urgency and failure exposure vary per request. Sellers either overcharge normal conditions or lose money during spikes.

## Solution

Basis separates quote discovery from paid execution:

1. Validate a typed, policy-bounded job.
2. Simulate through KeeperHub.
3. Price current execution cost, deadline protection, Marketplace fee, overhead and margin.
4. Return an expiring authenticated quote mapped to a fixed Marketplace tier.
5. Accept only `quoteId` through the matching paid KeeperHub workflow.
6. Re-simulate and preflight the persisted intent.
7. Execute through KeeperHub Direct Execution.
8. Require KeeperHub evidence, independent RPC success and adapter postconditions.
9. Persist an open, hash-chained accounting trail.

## KeeperHub integration

Basis uses KeeperHub in two roles:

- **Marketplace and MCP storefront:** `basis-quote`, four paid order tiers and `basis-status`.
- **Direct Execution provider:** simulation, sponsored/direct submission, status polling and receipt evidence.

Workflow graphs contain no transaction logic. Paid callbacks carry only `quoteId` plus an environment-only tier credential. Contract, calldata, value, chain, tier and refund terms come from the authenticated quote.

## MCP

The repository includes a local stdio MCP server with four tools:

- `basis_quote`
- `basis_status`
- `basis_evidence`
- `basis_marketplace_catalog`

Paid order execution remains KeeperHub-hosted so the local MCP cannot bypass payment authority.

## Differentiation

- Dynamic, versioned execution pricing instead of one fixed worst-case price
- Exact idempotency and durable admission before network effects
- Recovery that reconstructs persisted intent and never blindly retries uncertainty
- Independent RPC and adapter-specific receipt verification
- Fixed, quote-bound refund policy with default-off broadcasting
- Public evidence console with provenance labels and browser-side audit-chain verification

## Delivered adapters

- capped chain-pinned WETH wrap
- capped chain-pinned WETH unwrap
- exact-allowlist ERC-20 transfer
- pinned Morpho Blue `accrueInterest` policy on Base Sepolia

## Evidence and status

| Claim | Status |
|---|---|
| Hosted API and dashboard | Live |
| Local Basis MCP | Implemented |
| Six Marketplace workflows | Publicly visible with expected input fields |
| Hash-chained benchmark | 24 sponsored Base Sepolia WETH executions / 96 events |
| Historical pricing report | 1,003 tested observations; Basis-reported |
| Disclosed Phase 7 Morpho transaction | Not included |
| Completed paid Marketplace call | Not claimed |
| Live refund | Not claimed |
| Mainnet execution | Not claimed |

The evidence package is testnet-focused. Publication does not imply payment, and supported mainnet configuration does not imply a completed mainnet transaction.

## Dynamic-pricing bounty

Basis demonstrates the tier-ladder workaround required by fixed-price Marketplace listings. The accompanying proposal introduces a native signed quote mode with expiry, maximum buyer price and single-use quote identity. See [docs/BOUNTY-DYNAMIC-PRICING.md](docs/BOUNTY-DYNAMIC-PRICING.md).

## Judge walkthrough

1. Open the live evidence console and read the status/provenance labels.
2. Run `npm run mcp` and list the four local tools.
3. Use `basis_marketplace_catalog` to inspect the six KeeperHub workflows.
4. Request a testnet WETH quote; observe that no transaction is sent.
5. Verify `dashboard/evidence.jsonl` locally.
6. Review recovery, independent verification and refund boundaries in the linked docs.

## Limitations

Basis is unaudited hackathon software. KeeperHub does not expose settlement metadata to workflow nodes, a buyer-controlled paid invocation has not been documented, refund broadcasting defaults off, and the committed package lacks the historical Phase 7 Morpho execution record.
