import { describe, it, expect } from 'vitest';
import { scrubEmails, scrubPII } from '../pii-scrubber';

describe('scrubPII', () => {
  it('given_emailAddress_replacesWithRedactedMarker', () => {
    const input = 'Contact john.doe@example.com for more info';
    const result = scrubPII(input);

    expect(result).toBe('Contact [EMAIL_REDACTED] for more info');
    expect(result).not.toContain('john.doe@example.com');
  });

  it('given_multipleEmails_redactsAll', () => {
    const result = scrubPII('From alice@test.com to bob@test.com');

    expect(result).toBe('From [EMAIL_REDACTED] to [EMAIL_REDACTED]');
  });

  it('given_SSN_replacesWithRedactedMarker', () => {
    const result = scrubPII('SSN: 123-45-6789');

    expect(result).toBe('SSN: [SSN_REDACTED]');
  });

  it('given_creditCardWithDashes_replacesWithRedactedMarker', () => {
    const result = scrubPII('Card: 4111-1111-1111-1111');

    expect(result).toBe('Card: [CC_REDACTED]');
  });

  it('given_nullInput_returnsUndefined', () => {
    expect(scrubPII(null)).toBeUndefined();
    expect(scrubPII(undefined)).toBeUndefined();
  });

  it('given_emptyString_returnsUndefined', () => {
    expect(scrubPII('')).toBeUndefined();
  });

  it('given_nonPIIContent_returnsUnchanged', () => {
    const input = 'Hello, how can I help you today?';

    expect(scrubPII(input)).toBe(input);
  });

  it('given_multiplePIITypes_redactsEachWithCorrectMarker', () => {
    const result = scrubPII('User john@test.com SSN 123-45-6789');

    expect(result).not.toContain('john@test.com');
    expect(result).not.toContain('123-45-6789');
    expect(result).toContain('[EMAIL_REDACTED]');
    expect(result).toContain('[SSN_REDACTED]');
  });

  it('given_phoneNumbers_redactsAllFormats', () => {
    expect(scrubPII('Call 555-123-4567')).toContain('[PHONE_REDACTED]');
    expect(scrubPII('Call (555) 123-4567')).toContain('[PHONE_REDACTED]');
    expect(scrubPII('Call +1-555-123-4567')).toContain('[PHONE_REDACTED]');
  });

  it('given_amexCardNumber_redactsCorrectly', () => {
    const result = scrubPII('Card: 378282246310005');

    expect(result).toBe('Card: [CC_REDACTED]');
  });

  it('given_16digitNonLuhnNumber_doesNotRedactAsCreditCard', () => {
    const result = scrubPII('ID: 1234567890123456');

    expect(result).not.toContain('[CC_REDACTED]');
  });
});

describe('scrubEmails — linear, and exactly the old email regex (CodeQL js/polynomial-redos, #2760)', () => {
  const REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  it('redacts exactly what the global regex matched, on 20,000 random strings built from the characters that matter', () => {
    const alphabet = 'aZ9._%+-@ .xy@:';
    // A fixed-seed LCG: the same strings every run, so a mismatch is reproducible.
    let seed = 2760;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 20_000; n++) {
      const len = Math.floor(next() * 30);
      let text = '';
      for (let i = 0; i < len; i++) text += alphabet[Math.floor(next() * alphabet.length)];
      expect(scrubEmails(text), JSON.stringify(text)).toBe(text.replace(REGEX, '[EMAIL_REDACTED]'));
    }
  });

  it('matches the regex on the shapes that matter', () => {
    for (const text of ['a@b.co', 'x a.b+c@d-e.example.com y', 'a@b@c.com', 'a@.com', 'a@b.c', 'a@b.c0m.io9', '@b.com', 'a@b.com@c.org', 'u@h.co.uk.', 'q@w.ee,r@t.yy']) {
      expect(scrubEmails(text), text).toBe(text.replace(REGEX, '[EMAIL_REDACTED]'));
    }
  });

  it('stays linear on the input that made the regex quadratic: a long run of local-part characters with no @', () => {
    const started = Date.now();
    expect(scrubPII('%'.repeat(200_000))).toBe('%'.repeat(200_000));
    expect(scrubEmails(`${'a.'.repeat(100_000)}@${'b'.repeat(100_000)}`)).toContain('@');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

