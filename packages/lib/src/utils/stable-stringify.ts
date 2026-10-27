// Canonical JSON — sorts object keys at every depth so Postgres JSONB
// round-trips produce the same hash as the original write.
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
      : v
  );
}
