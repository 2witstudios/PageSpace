import { describe, it, expect } from 'vitest';
import { createAnonymizedActorEmail } from '../anonymize';

describe('createAnonymizedActorEmail', () => {
  it('should return a deterministic anonymized email for a given userId', () => {
    const result1 = createAnonymizedActorEmail('user-123');
    const result2 = createAnonymizedActorEmail('user-123');
    expect(result1).toBe(result2);
  });

  it('should return different anonymized emails for different userIds', () => {
    const result1 = createAnonymizedActorEmail('user-123');
    const result2 = createAnonymizedActorEmail('user-456');
    expect(result1).not.toBe(result2);
  });

  it('should have the format deleted_user_{hash}', () => {
    const result = createAnonymizedActorEmail('user-123');
    expect(result).toMatch(/^deleted_user_[a-f0-9]{12}$/);
  });

  it('should produce a 12-character hex hash suffix', () => {
    const result = createAnonymizedActorEmail('any-user-id');
    const hash = result.replace('deleted_user_', '');
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});
