/**
 * Pure audit-details sanitizer (#971) — GDPR Art 5(1)(c) data minimization.
 *
 * The `details` object on a security-audit event is folded into the
 * tamper-evident hash chain (see `computeSecurityEventHash` in
 * `security-audit.ts`) and therefore CANNOT be erased under GDPR Art 17:
 * removing it after the fact would break the chain. The only safe defense is
 * to keep user-typed text and PII OUT of `details` before it is hashed.
 *
 * Prior to this guard the only protection was a static source-scan test that
 * grepped search route source for the literal `query`. That test cannot catch
 * a runtime path that puts user text into `details`. This function is the
 * RUNTIME guard, wired into `auditRequest`/`audit` so every audit event is
 * sanitized before persistence.
 *
 * Design decisions:
 * - REDACT (not drop). We replace denylisted values with a constant marker
 *   rather than deleting the key. Keeping the key preserves the *shape* of the
 *   event for forensic analysis (you can still see that a query field was
 *   present) while guaranteeing the user-typed value never enters the hash
 *   chain. Dropping would silently change the object shape and lose that
 *   signal.
 * - Pure / referentially transparent. No I/O, no clock, no mutation of input.
 *   Always returns a NEW object for a non-empty input; identical inputs yield
 *   deep-equal outputs.
 * - Case-insensitive key matching, so `Query`, `EMAIL`, etc. are also caught.
 * - Two-tier matching. Most keys are matched EXACTLY (a substring rule would
 *   over-redact safe metadata, e.g. `content` would also catch `contentType` /
 *   `contentSize`). PII identifiers that routinely appear as prefixed/suffixed
 *   variants are matched by SUBSTRING — notably `email`, so invite-flow keys
 *   like `targetEmail` / `targetUserEmail` / `googleEmail` are all redacted and
 *   never enter the tamper-evident hash chain.
 * - Value type is irrelevant: a denylisted key is redacted regardless of
 *   whether its value is a string, number, or object (PII can hide in any).
 */

/** Constant inserted in place of any denylisted (user-typed / PII) value. */
export const REDACTED_MARKER = '[redacted]' as const;

/**
 * Keys whose values are assumed to carry user-typed text or PII and must never
 * reach the audit hash chain. Matched EXACTLY, case-insensitively.
 */
export const DENYLISTED_DETAIL_KEYS: readonly string[] = [
  'query',
  'q',
  'searchQuery',
  'searchTerm',
  'text',
  'prompt',
  'content',
  'email',
];

/**
 * PII identifier fragments matched as case-insensitive SUBSTRINGS of the key,
 * to catch the many prefixed/suffixed variants email addresses appear under
 * (`targetEmail`, `targetUserEmail`, `googleEmail`, `invitedEmail`, …). Keep
 * this list narrow — only fragments that are PII wherever they appear.
 */
export const DENYLISTED_KEY_SUBSTRINGS: readonly string[] = ['email'];

const DENYLIST_LOWER = new Set(DENYLISTED_DETAIL_KEYS.map((k) => k.toLowerCase()));

/**
 * Return a sanitized copy of an audit `details` object with user-typed text and
 * PII values redacted. Pure: never mutates its input.
 *
 * @param details - The audit event details, or undefined/null.
 * @returns A new object with denylisted values redacted, or `undefined` when
 *          given undefined/null (so callers can pass it straight through).
 */
export function sanitizeAuditDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined || details === null) {
    return undefined;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const keyLower = key.toLowerCase();
    const redact =
      DENYLIST_LOWER.has(keyLower) ||
      DENYLISTED_KEY_SUBSTRINGS.some((fragment) => keyLower.includes(fragment));
    out[key] = redact ? REDACTED_MARKER : value;
  }
  return out;
}
