/**
 * `redactKnownValues` — scrub known secret values out of anything flowing
 * back toward the model (epic invariant 3, "redaction in depth").
 *
 * This is a TRIPWIRE, not a boundary. An authorized site can echo a
 * credential, re-encode it, split it across fields, or mint a new one
 * (Λ10 — a stated non-guarantee). A literal scrub catches the common,
 * accidental case and, more usefully, tells the audit that the site handed
 * the value back at all. It must never be described, in code or in copy, as
 * the thing that keeps a credential away from the model: that is the
 * executor's reference-never-value contract.
 *
 * Values shorter than four characters are ignored — redacting them would
 * shred ordinary text without hiding anything an attacker could not guess.
 * Matching is literal (regex metacharacters are escaped), so a value like
 * `a.b*c+d` scrubs as itself and not as a pattern.
 *
 * Pure.
 */
export const REDACTED_VALUE = '[redacted]' as const;

/** Below this length a "secret" is not a secret, and scrubbing it is just damage. */
const MIN_VALUE_LENGTH = 4;

export type RedactKnownValues = (input: {
  readonly text: string;
  readonly knownValues: readonly string[];
}) => { readonly text: string; readonly redacted: boolean };

export const redactKnownValues: RedactKnownValues = ({ text, knownValues }) => {
  let out = text;
  let redacted = false;
  for (const value of knownValues) {
    if (typeof value !== 'string' || value.trim().length < MIN_VALUE_LENGTH) continue;
    if (!out.includes(value)) continue;
    out = out.split(value).join(REDACTED_VALUE);
    redacted = true;
  }
  return { text: out, redacted };
};
