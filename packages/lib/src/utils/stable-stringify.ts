/**
 * Serialize a value to canonical JSON with object keys sorted at every depth.
 *
 * Postgres JSONB does not guarantee key ordering on read-back, so any object
 * stored in a JSONB column can return with a different key order than it was
 * written. Using plain JSON.stringify over such values makes hash chains
 * non-deterministic. This replacer re-emits every plain object with its keys
 * sorted, producing the same output regardless of insertion order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
      : v
  );
}
