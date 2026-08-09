/** Versioned recursive canonical JSON for cryptographic integrity. */
export const CANONICAL_JSON_FORMAT = 'basis-canonical-json:v1' as const;

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') throw new Error('Canonical JSON requires bigint values to be converted to strings');
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`Canonical JSON rejects ${typeof value}`);
}
