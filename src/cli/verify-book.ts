import { resolve } from 'node:path';
import { verifyAuditChain } from '../ledger/database.ts';

const path = resolve(process.argv[2] ?? 'dashboard/evidence.jsonl');
const result = verifyAuditChain(path);
if (!result.valid) {
  console.error(`Audit verification failed at ${result.brokenAt ?? 'unknown'}: ${result.error ?? 'unknown error'}`);
  process.exitCode = 1;
} else {
  console.log(`Audit chain valid: ${path}`);
}
