import { describe, it, expect } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { resolveMessageId } from '../resolveMessageId';

describe('resolveMessageId', () => {
  it('given a well-formed client cuid, honors it', () => {
    const clientId = createId();
    expect(resolveMessageId(clientId)).toBe(clientId);
  });

  it('given undefined, mints a fresh cuid', () => {
    const result = resolveMessageId(undefined);
    expect(result).not.toBeUndefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it('given null, mints a fresh cuid', () => {
    const result = resolveMessageId(null);
    expect(result).not.toBeNull();
    expect(result.length).toBeGreaterThan(0);
  });

  it('given an empty string, mints a fresh cuid rather than persisting under an empty id', () => {
    const result = resolveMessageId('');
    expect(result).not.toBe('');
    expect(result.length).toBeGreaterThan(0);
  });

  it('given a malformed, non-cuid client id, mints a fresh cuid instead of trusting it', () => {
    const malformed = "'; DROP TABLE chat_messages; --";
    const result = resolveMessageId(malformed);
    expect(result).not.toBe(malformed);
  });
});
