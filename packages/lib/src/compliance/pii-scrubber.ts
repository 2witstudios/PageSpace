/**
 * PII scrubber for AI usage logs.
 *
 * Redacts common PII patterns (emails, phone numbers, SSNs, credit cards)
 * from text before it is persisted to monitoring tables. This is a
 * defense-in-depth measure — the primary control is to avoid logging
 * prompt/completion content altogether.
 */

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g;
const SSN_PATTERN = /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g;

// Matches 13–19 digit PAN candidates with optional separators
const PAN_CANDIDATE_PATTERN = /\b(\d[-.\s]?){12,18}\d\b/g;

function luhnValidate(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function scrubCreditCards(text: string): string {
  return text.replace(PAN_CANDIDATE_PATTERN, (match) => {
    const digits = match.replace(/[-.\s]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValidate(digits)) {
      return '[CC_REDACTED]';
    }
    return match;
  });
}

// Order matters: credit cards before phones (phone pattern can match digit
// subsequences inside a PAN), SSNs before phones for the same reason.
export function scrubPII(text: string | undefined | null): string | undefined {
  if (!text) return undefined;

  let result = text.replace(EMAIL_PATTERN, '[EMAIL_REDACTED]');
  result = scrubCreditCards(result);
  result = result.replace(SSN_PATTERN, '[SSN_REDACTED]');
  result = result.replace(PHONE_PATTERN, '[PHONE_REDACTED]');
  return result;
}
