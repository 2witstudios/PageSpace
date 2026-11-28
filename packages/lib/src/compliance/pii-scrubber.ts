/**
 * PII scrubber for AI usage logs.
 *
 * Redacts common PII patterns (emails, phone numbers, SSNs, credit cards)
 * from text before it is persisted to monitoring tables. This is a
 * defense-in-depth measure — the primary control is to avoid logging
 * prompt/completion content altogether.
 */

// Emails are found by a LINEAR scan (scrubEmails), not a regex: scrubPII also runs over error
// messages a library produced (errorLogFields, the logger), and the equivalent global regex
// `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` is quadratic on a long run of local-part
// characters with no '@' (CodeQL js/polynomial-redos, #2760). Same matches, proven against the
// regex in pii-scrubber.test.ts.
const isLocalChar = (c: string) => /[a-zA-Z0-9._%+-]/.test(c);
const isDomainChar = (c: string) => /[a-zA-Z0-9.-]/.test(c);
const isLetter = (c: string) => /[a-zA-Z]/.test(c);

/** Replace every `local@domain.tld` the regex above would match, left to right, in one pass. */
export function scrubEmails(text: string): string {
  let out = '';
  let last = 0;
  let at = text.indexOf('@');
  while (at !== -1) {
    // Local part: the run of local characters ending right before '@', not reaching back past
    // the previous match.
    let start = at;
    while (start > last && isLocalChar(text[start - 1])) start--;
    let end = -1;
    if (start < at) {
      let runEnd = at + 1;
      while (runEnd < text.length && isDomainChar(text[runEnd])) runEnd++;
      // Domain: the LAST '.' in the run with at least one domain character before it and two
      // letters after it (the regex's greedy backtracking), then every letter that follows.
      for (let dot = runEnd - 3; dot > at + 1; dot--) {
        if (text[dot] === '.' && isLetter(text[dot + 1]) && isLetter(text[dot + 2])) {
          end = dot + 3;
          while (end < runEnd && isLetter(text[end])) end++;
          break;
        }
      }
    }
    if (end === -1) {
      at = text.indexOf('@', at + 1);
      continue;
    }
    out += `${text.slice(last, start)}[EMAIL_REDACTED]`;
    last = end;
    at = text.indexOf('@', end);
  }
  return out + text.slice(last);
}
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

  let result = scrubEmails(text);
  result = scrubCreditCards(result);
  result = result.replace(SSN_PATTERN, '[SSN_REDACTED]');
  result = result.replace(PHONE_PATTERN, '[PHONE_REDACTED]');
  return result;
}
