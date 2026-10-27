/**
 * LIKE/ILIKE pattern escaping — pure, no DB access.
 *
 * Postgres's default LIKE/ILIKE escape character is backslash, so an unescaped
 * `%`, `_`, or `\` in a user-supplied search term is read as pattern syntax
 * instead of literal text — silently over- or under-matching (e.g. a search for
 * a task titled "50% off" would otherwise treat `%` as a wildcard).
 */

/**
 * Escape LIKE/ILIKE special characters (`%`, `_`, `\`) in a search term so it
 * matches as a literal substring.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
