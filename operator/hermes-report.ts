/**
 * Hermes Operator — Read-Only Reconciliation Report
 *
 * Hermes is Basis's AI analyst. It has NO write access.
 * It reads the ledger and produces:
 * - Execution summary
 * - Failure classification
 * - Deadline performance
 * - Audit chain verification
 * - Anomaly detection
 */

import { readFileSync, existsSync } from 'fs';
import { verifyAuditChain } from '../src/ledger/database.ts';

interface AuditEvent {
  seq: number;
  timestamp: string;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

function loadEvents(path: string): AuditEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function classifyFailure(event: AuditEvent): string {
  const error = (event.payload.error as string) ?? '';
  if (error.includes('insufficient')) return 'insufficient-balance';
  if (error.includes('revert')) return 'contract-revert';
  if (error.includes('timeout')) return 'keeperhub-timeout';
  if (error.includes('nonce')) return 'nonce-contention';
  if (error.includes('gas')) return 'gas-limit-shortfall';
  if (error.includes('slippage')) return 'slippage';
  return 'unknown';
}

function main() {
  const jsonlPath = process.argv[2] || 'evidence/batch.jsonl';
  console.log('═══════════════════════════════════════════════════════');
  console.log('  HERMES OPERATOR — Reconciliation Report');
  console.log('  Mode: READ-ONLY (no write permissions)');
  console.log('  Source:', jsonlPath);
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  const events = loadEvents(jsonlPath);
  if (events.length === 0) {
    console.log('  No events found.');
    return;
  }

  // Event counts by type
  const byType: Record<string, number> = {};
  for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;

  console.log('  EVENT SUMMARY');
  console.log('  ─────────────');
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(25)} ${count}`);
  }

  // Execution metrics
  const quotes = events.filter(e => e.type === 'QUOTE_ISSUED');
  const orders = events.filter(e => e.type === 'ORDER_CREATED');
  const verified = events.filter(e => e.type === 'EXECUTION_VERIFIED');
  const failed = events.filter(e => e.type === 'EXECUTION_FAILED');

  console.log('');
  console.log('  EXECUTION METRICS');
  console.log('  ─────────────────');
  console.log(`    Quotes issued:       ${quotes.length}`);
  console.log(`    Orders placed:       ${orders.length}`);
  console.log(`    Executions verified: ${verified.length}`);
  console.log(`    Executions failed:   ${failed.length}`);
  console.log(`    Success rate:        ${verified.length + failed.length > 0 ? (verified.length / (verified.length + failed.length) * 100).toFixed(1) : '—'}%`);

  // Deadline performance
  const deadlineHits = verified.filter(e => e.payload.deadlineHit !== false).length;
  const deadlineMisses = verified.filter(e => e.payload.deadlineHit === false).length;
  console.log('');
  console.log('  DEADLINE PERFORMANCE');
  console.log('  ────────────────────');
  console.log(`    Hit:    ${deadlineHits}`);
  console.log(`    Missed: ${deadlineMisses}`);
  console.log(`    Rate:   ${verified.length > 0 ? (deadlineHits / verified.length * 100).toFixed(1) : '—'}%`);

  // Failure classification
  if (failed.length > 0) {
    console.log('');
    console.log('  FAILURE CLASSIFICATION');
    console.log('  ──────────────────────');
    const classes: Record<string, number> = {};
    for (const f of failed) {
      const cls = classifyFailure(f);
      classes[cls] = (classes[cls] ?? 0) + 1;
    }
    for (const [cls, count] of Object.entries(classes)) {
      console.log(`    ${cls.padEnd(25)} ${count}`);
    }
  }

  // Sponsorship
  const sponsored = verified.filter(e => e.payload.sponsored === true).length;
  const selfPaid = verified.filter(e => e.payload.sponsored === false).length;
  console.log('');
  console.log('  GAS ECONOMICS');
  console.log('  ─────────────');
  console.log(`    Sponsored (KeeperHub): ${sponsored}`);
  console.log(`    Self-paid:             ${selfPaid}`);
  console.log(`    Realized cost:         $0.00 (all sponsored on testnet)`);

  // Audit chain verification
  console.log('');
  console.log('  AUDIT CHAIN VERIFICATION');
  console.log('  ────────────────────────');
  const result = verifyAuditChain(jsonlPath);
  if (result.valid) {
    console.log(`    ✓ Chain valid — ${events.length} events, unbroken`);
    console.log(`    Last hash: ${events[events.length - 1]!.hash.slice(0, 32)}...`);
  } else {
    console.log(`    ✗ CHAIN BROKEN at seq ${result.brokenAt}: ${result.error}`);
  }

  // Anomalies
  console.log('');
  console.log('  ANOMALY DETECTION');
  console.log('  ─────────────────');
  const quotesWithoutOrders = quotes.length - orders.length;
  if (quotesWithoutOrders > 0) {
    console.log(`    ⚠ ${quotesWithoutOrders} quotes expired without order`);
  }
  if (failed.length > 0) {
    console.log(`    ⚠ ${failed.length} failed executions need investigation`);
  }
  if (!result.valid) {
    console.log(`    🚨 Audit chain integrity compromised!`);
  }
  if (quotesWithoutOrders === 0 && failed.length === 0 && result.valid) {
    console.log(`    ✓ No anomalies detected`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Report generated:', new Date().toISOString());
  console.log('  Hermes holds NO write permissions.');
  console.log('═══════════════════════════════════════════════════════');
}

main();
