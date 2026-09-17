/**
 * Strict base64 → bytes; `null` for anything that is not well-formed base64.
 * Restated here rather than imported from the env-bridge because the two
 * authorities never share a module (ADR 0004 §9).
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodeBase64(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  return new Uint8Array(Buffer.from(value, 'base64'));
}
