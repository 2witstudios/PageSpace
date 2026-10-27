import { describe, it, expect } from 'vitest';
import { sanitizeConnectMetadata } from '../connect-metadata';

describe('sanitizeConnectMetadata', () => {
  it('passes through well-formed scope descriptions and notes', () => {
    expect(
      sanitizeConnectMetadata({
        oauthScopeDescriptions: { repo: 'Read/write code', 'read:user': 'Read profile' },
        connectNotes: 'Agents act as you.',
      })
    ).toEqual({
      oauthScopeDescriptions: { repo: 'Read/write code', 'read:user': 'Read profile' },
      connectNotes: 'Agents act as you.',
    });
  });

  it('drops non-string scope values and keeps the string ones', () => {
    expect(
      sanitizeConnectMetadata({
        oauthScopeDescriptions: { repo: 'ok', bad: 123, worse: { nested: true } },
      })
    ).toEqual({ oauthScopeDescriptions: { repo: 'ok' }, connectNotes: null });
  });

  it('returns null when scope descriptions is not a record (string / array / number)', () => {
    for (const bad of ['nope', ['a', 'b'], 42, true]) {
      expect(sanitizeConnectMetadata({ oauthScopeDescriptions: bad }).oauthScopeDescriptions).toBeNull();
    }
  });

  it('returns null scopes when every value is non-string', () => {
    expect(
      sanitizeConnectMetadata({ oauthScopeDescriptions: { a: 1, b: false } }).oauthScopeDescriptions
    ).toBeNull();
  });

  it('returns null connectNotes when it is not a string', () => {
    expect(sanitizeConnectMetadata({ connectNotes: { msg: 'x' } }).connectNotes).toBeNull();
    expect(sanitizeConnectMetadata({ connectNotes: 123 }).connectNotes).toBeNull();
  });

  it('handles null / non-object config safely', () => {
    expect(sanitizeConnectMetadata(null)).toEqual({ oauthScopeDescriptions: null, connectNotes: null });
    expect(sanitizeConnectMetadata('garbage')).toEqual({ oauthScopeDescriptions: null, connectNotes: null });
    expect(sanitizeConnectMetadata(undefined)).toEqual({ oauthScopeDescriptions: null, connectNotes: null });
  });
});
