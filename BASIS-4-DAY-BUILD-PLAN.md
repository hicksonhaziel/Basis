# Basis — Brutal 4-Day Build Plan

**Rule:** every day ends with working evidence, not unfinished code. If a stretch item threatens the day's ship gate, cut it.

---

## Day 1 — Make Basis real

Build the deterministic core and eliminate the dangerous unknowns first.

### Must finish

- Scaffold the TypeScript/Node 22 monorepo.
- Implement the typed job-adapter interface.
- Implement one benchmark adapter: `erc20.transfer` or `weth.wrap`.
- Integrate KeeperHub:
  - API-key validation
  - organization-wallet lookup
  - `simulate: true`
  - direct execution
  - poll using `X-Poll-Interval-Hint`
  - verify `receipts[].verified` and `receiptStatus`
- Implement canonical intent hashing and stable idempotency keys.
- Implement live `eth_feeHistory` collection.
- Implement Chainlink native-asset/USD reading.
- Implement the pure, versioned pricing function.
- Implement signed, expiring quotes.
- Test KeeperHub x402 payment immediately and record whether `CHAIN_MISMATCH` still exists.
- Create SQLite schema and append-only hash-chained JSONL ledger.
- Add offline unit/contract tests for pricing, quote signing, idempotency, receipt handling, and ledger verification.

### End-of-day evidence

- One command requests a quote and displays its complete price breakdown.
- The same job at `1h`, `5m`, and `next-block` produces explainably different prices.
- One real testnet transaction executes through KeeperHub.
- Its KeeperHub execution ID, transaction hash, gas used, and independently verified receipt are saved.
- Replaying the same execution request does **not** execute twice.
- One historical quote replays through the pricing function and produces the identical price.
- The payment-rail result is documented: working receipt or reproducible `CHAIN_MISMATCH` evidence.
- All offline tests pass from a clean clone.

### Ship gate

> **Do not start Day 2 unless quote → simulate → execute → verified receipt works end to end.**

---

## Day 2 — Close the commercial loop

Turn the execution core into a product another agent can discover, pay for, and use.

### Must finish

- Implement the public API:
  - `POST /quotes`
  - `POST /orders`
  - `GET /orders/:id`
  - `GET /metrics`
- Build KeeperHub storefront workflows:
  - `basis-quote`
  - `basis-order-t1`
  - `basis-order-t2`
  - `basis-order-t3`
  - `basis-order-t4`
- Publish the workflows and expose the typed per-workflow MCP tool.
- Integrate x402 payment through KeeperHub.
- If KeeperHub payment remains broken, complete the isolated direct-x402 fallback and label every payment path honestly.
- Validate quote signature, expiry, job hash, payment tier, and one-time consumption.
- Re-simulate after payment and before broadcast.
- Implement the full order state machine.
- Implement refund execution through KeeperHub.
- Implement one real value-neutral protocol adapter such as `protocol.settle`, `keeper.poke`, or `rewards.claimFor`.
- Build a minimal buyer SDK or CLI.
- Add integration and chaos tests for duplicate delivery, expired quote, re-simulation failure, revert, timeout, refund, and worker restart.

### End-of-day evidence

- A clean buyer agent discovers Basis through MCP.
- It requests a quote, pays, and receives a verified transaction result.
- The payment has a real settlement receipt—or a clearly identified direct-x402 fallback receipt if KeeperHub's rail is defective.
- A paid order that fails re-simulation produces a verified KeeperHub refund.
- Duplicate order delivery cannot double-execute.
- Timeout enters `UNCERTAIN` and never causes a blind re-broadcast.
- The real value-neutral adapter executes successfully on testnet.
- The ledger contains the complete quote → payment → execution/refund chain.

### Ship gate

> **Do not start Day 3 unless an external agent can pay Basis and receive either a verified execution or verified refund.**

---

## Day 3 — Build first-place evidence

Prove that Basis is reliable, economically real, and better than a polished prototype.

### Must finish

- Execute at least one value-neutral **Base or Ethereum mainnet** job through KeeperHub.
- Run 100+ testnet jobs across deadline tiers.
- Collect 30 days of historical `eth_feeHistory` and backtest the pricing model.
- Calculate:
  - gross revenue
  - marketplace fees
  - market gas cost
  - realized Basis cost
  - realized margin
  - deadline hit rate
  - refund rate
  - pricing error P50/P95
- Build and deploy the public open-book dashboard.
- Add browser-side audit-chain verification and tamper simulation.
- Reconcile Basis records against KeeperHub records and independent RPC receipts.
- Build the deterministic reconciliation worker and read-only report:
  - explicit state and receipt comparisons
  - restart recovery
  - reconciliation alerts
  - deterministic operations digest
- Implement circuit breakers and underwriting exposure limits.
- Write the dynamic-pricing bounty proposal and execution-seller starter template.
- Create `FAILURE-MODES.md` and `THREAT-MODEL.md` with honest limitations.

### End-of-day evidence

- Public mainnet transaction link and KeeperHub execution ID.
- 100+ testnet execution records in the book.
- Live metrics and historical backtest metrics displayed separately.
- Public dashboard shows P&L, deadline performance, pricing error, refunds, and audit status.
- Browser verifies the committed hash chain and catches simulated tampering.
- The deterministic worker produces a reconciliation report and operations digest from explicit rules.
- Dynamic-pricing proposal and starter template are ready for submission or PR.
- A stranger can run tests, dashboard, book verification, and backtest replay without secrets.

### Ship gate

> **Do not start Day 4 unless Basis has mainnet proof, measurable economics, and a public open book.**

---

## Day 4 — Harden, prove, submit, win the pitch

No new product ideas. Only correctness, evidence, presentation, and submission.

### Must finish

- Run the complete test suite from a fresh clone and clean environment.
- Run final chaos scenarios and repair every critical failure.
- Independently verify every transaction and payment claim against public chains.
- Export the final evidence bundle:
  - transaction links
  - KeeperHub execution IDs
  - payment receipts
  - refund receipts
  - backtest report
  - open-book ledger
  - reconciliation report
- Finish README with a 60-second zero-secret quickstart.
- Finish architecture diagram, pricing explanation, failure modes, and competitive positioning.
- Ensure the hosted API, MCP tool, dashboard, and evidence links work from an unrelated machine.
- Record the demo video using a clean buyer agent.
- Submit GitHub link, video, and verified KeeperHub transaction link before the deadline.
- Submit the onboarding/dynamic-pricing bounty artifact.
- Prepare a deterministic fallback demo using committed real evidence.
- Rehearse the five-minute pitch until it consistently finishes under time.

### End-of-day evidence

- Public repository builds and tests cleanly.
- Public API, marketplace workflow, MCP tool, and dashboard are live.
- Demo shows: quote → payment → KeeperHub execution → verified receipt → open book.
- Failure demo shows: paid rejected/late job → KeeperHub refund.
- Every numerical claim can be traced to a ledger row and public receipt.
- DoraHacks submission is complete and confirmed.
- Bounty submission is complete.
- Five-minute pitch and backup demo are ready.

### Final ship gate

> **A judge can clone it, verify it, buy execution, inspect the mainnet proof, and understand why KeeperHub needs dynamic pricing—without trusting us.**

---

## Non-negotiables

These must survive every scope cut:

1. Deterministic, reproducible quote.
2. Real paid order.
3. Real execution through KeeperHub.
4. Independently verified receipt.
5. Stable idempotency and no blind retry on uncertain outcomes.
6. Verified refund path.
7. Mainnet evidence.
8. Open book with honest live-versus-backtest separation.
9. Deterministic reconciliation and reporting; no model provider participates in runtime.
10. Complete submission artifacts.

## Cut first if necessary

1. MPP/Tempo support.
2. Swap/private-routing adapter.
3. Aave value-bearing showcase.
4. Buyer npm package—keep HTTP and MCP.
5. Telegram polish.
6. Visual dashboard polish—never cut the metrics or evidence.
