import { describe, it, expect } from 'vitest';
import { HONEYPOT_FIELD_NAME, isHoneypotTriggered } from '../honeypot';

describe('isHoneypotTriggered', () => {
  it('flags a submission where the honeypot field is non-empty', () => {
    expect(isHoneypotTriggered({ [HONEYPOT_FIELD_NAME]: 'bot filled this in' })).toBe(true);
  });

  it('does not flag a submission where the honeypot field is absent', () => {
    expect(isHoneypotTriggered({ name: 'Ada' })).toBe(false);
  });

  it('does not flag a submission where the honeypot field is an empty string', () => {
    expect(isHoneypotTriggered({ [HONEYPOT_FIELD_NAME]: '' })).toBe(false);
  });

  it('does not flag a submission where the honeypot field is whitespace only', () => {
    expect(isHoneypotTriggered({ [HONEYPOT_FIELD_NAME]: '   ' })).toBe(false);
  });

  it('flags a submission even when the honeypot value is not a string', () => {
    expect(isHoneypotTriggered({ [HONEYPOT_FIELD_NAME]: 123 as unknown as string })).toBe(true);
  });
});
