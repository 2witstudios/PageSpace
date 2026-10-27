/**
 * `canonicalJson` — the one deterministic serialization every digest in the
 * agent-accounts authority hashes (ADR 0004 §3.2 `digestRequest`, §2.2
 * `encodeGrant`).
 *
 * Object keys are sorted recursively; arrays stay positional (a query pair
 * list is ordered by construction); `undefined` values are dropped exactly as
 * JSON drops them on the wire; types stay distinct (`1` ≠ `'1'`, `null` ≠
 * absent). The env-bridge has the same rule in `grant-args.ts`; it is
 * restated here rather than imported because the two authorities must never
 * share a module (ADR 0004 §9: "Nothing imports one into the other").
 *
 * Pure: no I/O, no crypto.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}
