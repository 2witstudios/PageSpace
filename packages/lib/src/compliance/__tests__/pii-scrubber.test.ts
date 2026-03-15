import { describe, it, expect } from 'vitest';
import { scrubPII } from '../pii-scrubber';

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
