export const CANONICAL_JSON_FORMAT: 'basis-canonical-json:v1';
export const AUDIT_HASH_FORMAT: 'sha256:v2';

export interface BrowserAuditEvent {
  seq: number;
  timestamp: string;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
  canonicalizationFormat: string;
  hashFormat: string;
  prevHash: string;
  hash: string;
}

export function canonicalJson(value: unknown): string;
export function computeAuditHash(event: BrowserAuditEvent): Promise<string>;
export function verifyAuditEvents(events: BrowserAuditEvent[]): Promise<{
  valid: boolean;
  brokenAt?: number;
  error?: string;
}>;
