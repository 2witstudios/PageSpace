/**
 * PII scrubber for AI usage logs.
 *
 * Redacts common PII patterns (emails, phone numbers, SSNs) from text
 * before it is persisted to monitoring tables. This is a defense-in-depth
 * measure — the primary control is to avoid logging prompt/completion
 * content altogether.
 */

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g;
const SSN_PATTERN = /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d{4}[-.\s]?){3}\d{4}\b/g;

export function scrubPII(text: string | undefined | null): string | undefined {
  if (!text) return undefined;

  return text
    .replace(EMAIL_PATTERN, '[EMAIL_REDACTED]')
    .replace(SSN_PATTERN, '[SSN_REDACTED]')
    .replace(CREDIT_CARD_PATTERN, '[CC_REDACTED]')
    .replace(PHONE_PATTERN, '[PHONE_REDACTED]');
}
