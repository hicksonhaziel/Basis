/** Deterministic read-only reconciliation report. */
import { existsSync, readFileSync } from 'node:fs';
import { verifyAuditChain } from '../src/ledger/database.ts';

interface Event { seq: number; timestamp: string; type: string; entityId: string; payload: Record<string, unknown>; hash: string; }

function load(path: string): Event[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Event);
}

export function buildReconciliationReport(path: string): Record<string, unknown> {
  const events = load(path);
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  const transitions = events.filter((event) => event.type === 'STATE_TRANSITION');
  const uncertain = transitions.filter((event) => event.payload.to === 'UNCERTAIN').length;
  const succeeded = transitions.filter((event) => event.payload.to === 'SUCCEEDED').length;
  const failed = transitions.filter((event) => event.payload.to === 'FAILED').length;
  const audit = verifyAuditChain(path);
  return {
    generatedAt: new Date().toISOString(),
    source: path,
    readOnly: true,
    deterministic: true,
    eventCount: events.length,
    counts,
    lifecycle: { succeeded, failed, uncertain },
    audit,
    alerts: [
      ...(!audit.valid ? [{ code: 'AUDIT_CHAIN_BROKEN', detail: audit.error }] : []),
      ...(uncertain > 0 ? [{ code: 'UNCERTAIN_EXECUTIONS', count: uncertain }] : []),
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? 'evidence/batch.jsonl';
  process.stdout.write(`${JSON.stringify(buildReconciliationReport(path), null, 2)}\n`);
}
