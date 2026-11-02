import { createHash } from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) {
        sorted[key] = sortKeys(item);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON: object keys sorted recursively (UTF-16 code unit order), `undefined` fields
 * dropped, no insignificant whitespace. Two payloads with the same content always serialize to the
 * same string regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Lowercase hex SHA-256 of the canonical JSON of `value`. */
export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
