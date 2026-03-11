import { describe, it, expect } from 'vitest';
import { scrubPII } from '../pii-scrubber';

describe('scrubPII', () => {
  it('redactsEmailAddresses', () => {
    const input = 'Contact john.doe@example.com for more info';
    const result = scrubPII(input);
    expect(result).toBe('Contact [EMAIL_REDACTED] for more info');
    expect(result).not.toContain('john.doe@example.com');
  });

  it('redactsMultipleEmails', () => {
    const input = 'From alice@test.com to bob@test.com';
    const result = scrubPII(input);
    expect(result).toBe('From [EMAIL_REDACTED] to [EMAIL_REDACTED]');
  });

  it('redactsSSNs', () => {
    const input = 'SSN: 123-45-6789';
    const result = scrubPII(input);
    expect(result).toBe('SSN: [SSN_REDACTED]');
  });

  it('redactsCreditCards', () => {
    const input = 'Card: 4111-1111-1111-1111';
    const result = scrubPII(input);
    expect(result).toBe('Card: [CC_REDACTED]');
  });

  it('returnsUndefinedForNullInput', () => {
    expect(scrubPII(null)).toBeUndefined();
    expect(scrubPII(undefined)).toBeUndefined();
  });

  it('returnsUndefinedForEmptyString', () => {
    expect(scrubPII('')).toBeUndefined();
  });

  it('preservesNonPIIContent', () => {
    const input = 'Hello, how can I help you today?';
    expect(scrubPII(input)).toBe(input);
  });

  it('handlesMultiplePIITypes', () => {
    const input = 'User john@test.com SSN 123-45-6789';
    const result = scrubPII(input);
    expect(result).not.toContain('john@test.com');
    expect(result).not.toContain('123-45-6789');
    expect(result).toContain('[EMAIL_REDACTED]');
    expect(result).toContain('[SSN_REDACTED]');
  });

  it('redactsPhoneNumbers', () => {
    expect(scrubPII('Call 555-123-4567')).toContain('[PHONE_REDACTED]');
    expect(scrubPII('Call (555) 123-4567')).toContain('[PHONE_REDACTED]');
    expect(scrubPII('Call +1-555-123-4567')).toContain('[PHONE_REDACTED]');
  });

  it('redactsAmExCards', () => {
    // AmEx test number (15 digits, passes Luhn)
    const result = scrubPII('Card: 378282246310005');
    expect(result).toBe('Card: [CC_REDACTED]');
  });

  it('doesNotRedactNonLuhnNumbers', () => {
    // 16 digits but fails Luhn check
    const result = scrubPII('ID: 1234567890123456');
    expect(result).not.toContain('[CC_REDACTED]');
  });
});
