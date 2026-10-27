/**
 * djb2 over UTF-16 code units, as an unsigned 32-bit integer.
 *
 * Deliberately non-cryptographic and dependency-free: it must run identically
 * in the browser (no `node:crypto`) and in Node, with nothing but the string
 * as input. Shared by `SCHEMA_HASH` (`collab-schema.ts`, a drift detector)
 * and `userColor` (`user-color.ts`, a palette index) — neither is a security
 * boundary. In its own module so that a colour helper does not have to import
 * the schema, and everything it pulls in, for six lines.
 */
export function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33 + input.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
