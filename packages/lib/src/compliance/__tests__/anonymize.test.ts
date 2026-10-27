import { describe, it, expect } from 'vitest';
import { createAnonymizedActorEmail } from '../anonymize';

describe('createAnonymizedActorEmail', () => {
  it('given_sameUserId_returnsDeterministicResult', () => {
    const result1 = createAnonymizedActorEmail('user-123');
    const result2 = createAnonymizedActorEmail('user-123');

    expect(result1).toBe(result2);
  });

  it('given_differentUserIds_returnsDifferentEmails', () => {
    const result1 = createAnonymizedActorEmail('user-123');
    const result2 = createAnonymizedActorEmail('user-456');

    expect(result1).not.toBe(result2);
  });

  it('given_anyUserId_producesExpectedFormat', () => {
    const result = createAnonymizedActorEmail('user-123');

    expect(result).toMatch(/^deleted_user_[a-f0-9]{12}$/);
  });

  it('given_anyUserId_hashSuffixIs12CharHex', () => {
    const result = createAnonymizedActorEmail('any-user-id');
    const hash = result.replace('deleted_user_', '');

    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});
