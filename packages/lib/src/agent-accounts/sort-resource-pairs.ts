/**
 * `sortResourcePairs` — `[key, value]` resource pairs sorted by key with a
 * code-unit compare, values of one key kept in extraction order (a stable
 * sort), so both sides of a digest see one order. Returns a copy. Pure.
 */
export function sortResourcePairs(pairs: readonly (readonly [string, string])[]): readonly (readonly [string, string])[] {
  return [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
