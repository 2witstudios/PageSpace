import { describe, it, expect } from 'vitest';
import { globalChannelId, parseGlobalChannelId } from '../global-channel-id';

describe('globalChannelId', () => {
  it('given a userId, should return the `user:${userId}:global` literal', () => {
    expect(globalChannelId('user-1')).toBe('user:user-1:global');
  });

  it('given a userId containing colons, should embed it verbatim (the format is positional, not delimited)', () => {
    expect(globalChannelId('a:b:c')).toBe('user:a:b:c:global');
  });
});

describe('parseGlobalChannelId', () => {
  it('given a well-formed global channel id, should return the embedded userId', () => {
    expect(parseGlobalChannelId('user:user-1:global')).toBe('user-1');
  });

  it('given a userId that itself contains colons, should round-trip with globalChannelId', () => {
    const userId = 'a:b:c';
    expect(parseGlobalChannelId(globalChannelId(userId))).toBe(userId);
  });

  it('given a non-global channel id, should return null', () => {
    expect(parseGlobalChannelId('user:user-1:tasks')).toBeNull();
  });

  it('given a string that does not start with `user:`, should return null', () => {
    expect(parseGlobalChannelId('page-123')).toBeNull();
  });

  it('given an empty string, should return null', () => {
    expect(parseGlobalChannelId('')).toBeNull();
  });

  it('given a string missing the user-id segment (`user::global`), should return an empty userId — caller must reject empty ids if needed', () => {
    expect(parseGlobalChannelId('user::global')).toBe('');
  });
});
