export const CANONICAL_JSON_FORMAT = 'basis-canonical-json:v1';
export const AUDIT_HASH_FORMAT = 'sha256:v2';

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error(`Canonical JSON rejects ${typeof value}`);
}

export async function computeAuditHash(event) {
  if (event.canonicalizationFormat !== CANONICAL_JSON_FORMAT || event.hashFormat !== AUDIT_HASH_FORMAT) {
    throw new Error('Unsupported audit integrity format');
  }
  const material = {
    seq: event.seq, timestamp: event.timestamp, type: event.type, entityId: event.entityId,
    payload: event.payload, prevHash: event.prevHash,
    canonicalizationFormat: event.canonicalizationFormat, hashFormat: event.hashFormat,
  };
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(material)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyAuditEvents(events) {
  let prevHash = '0'.repeat(64);
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.seq !== index + 1) return { valid: false, brokenAt: index + 1, error: `sequence mismatch: expected ${index + 1}, got ${event.seq}` };
    if (event.prevHash !== prevHash) return { valid: false, brokenAt: event.seq, error: 'prevHash mismatch' };
    try {
      if (event.hash !== await computeAuditHash(event)) return { valid: false, brokenAt: event.seq, error: 'hash mismatch' };
    } catch (error) {
      return { valid: false, brokenAt: event.seq, error: error instanceof Error ? error.message : String(error) };
    }
    prevHash = event.hash;
  }
  return { valid: true };
}
