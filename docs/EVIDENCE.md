# Public evidence index

Basis separates implementation facts, public-chain facts, KeeperHub-reported facts and Basis-local ledger facts. Missing evidence remains missing; one provenance class is never substituted for another.

## Public surfaces

| Surface | Contents |
|---|---|
| Dashboard `/` | Policy, provenance, live API counts, backtest, audit verification and limitations |
| `/metrics` | Live aggregate quote/order/execution/refund and audit-chain counts |
| `/phase7-evidence.json` | Redacted Morpho policy and explicit execution-evidence availability |
| `/backtest-report.json` | Basis-reported historical fee replay summary |
| `/evidence.jsonl` | Committed benchmark audit chain used by browser verification |

## Evidence currently present

### Benchmark ledger

- 96 canonical SHA-256 audit events
- 24 sponsored Base Sepolia WETH benchmark executions
- browser and CLI verification of sequence, predecessor and event hashes
- benchmark data only; not Phase 7 Morpho proof or paid commerce

Verify locally:

```bash
npm run verify:book -- dashboard/evidence.jsonl
```

### Historical pricing report

- Base fee-history replay
- 1,003 tested observations after the rolling window
- deadline-tier coverage, underpricing count and overpricing percentiles

The original 1,024-block RPC response and immutable block range were not retained. The dashboard therefore labels the report **Basis-reported historical backtest**, not independently reproducible evidence.

### Morpho policy evidence

The repository fixes and tests:

- Base Sepolia chain `84532`
- one Morpho contract and market ID
- one function selector and exact raw `AccrueInterest` topic
- Morpho and IRM runtime-code hashes
- zero native value, 180,000 gas ceiling and 300-second accrual staleness
- quote-time and pre-submit deployment/market checks
- exact event values and receipt-block historical-state verification

## Evidence not currently disclosed

The committed package does not contain a Phase 7 Morpho transaction hash, KeeperHub execution ID, Basis quote/order/execution IDs, decoded event values or historical receipt-block result. It therefore does not claim a verified Morpho execution.

The repository also does not disclose evidence of:

- a completed paid Marketplace call
- x402/MPP settlement receipt delivered to Basis
- a live refund transaction
- a mainnet execution
- public-chain revenue or realized margin

## Status labels

Marketplace workflows were submitted for public publication. `UNPAID` and `NOT REFUNDED` remain accurate for the disclosed evidence package. Publication status is not payment status.

## Redaction policy

Public evidence must not contain:

- KeeperHub API keys
- workflow bearer credentials
- quote MAC values
- authorization headers
- signing keys
- private RPC URLs
- complete outbound requests when they include operational metadata

Transaction hashes, block numbers, public contract addresses, market IDs, runtime-code hashes and KeeperHub execution IDs may be published only with an explicit provenance label.
