import { describe, it, expect } from 'vitest';
import {
  buildPublicProfileResult,
  buildExactEmailMatchResult,
  resolveFindUser,
  buildConnectionSearchResult,
} from '../enumeration-safe';

// ============================================================================
// Pure response-shaping helpers for the user-enumeration / email-harvest
// remediations (audit findings M3, L1, L2).
//
// These functions encode the security decisions as pure projections so the
// "what data leaves the server" question is unit-testable in isolation.
// ============================================================================

describe('buildPublicProfileResult (M3 — email harvest)', () => {
  const row = {
    userId: 'user_1',
    username: 'alice',
    displayName: 'Alice',
    bio: 'hello',
    avatarUrl: 'https://cdn/avatar.png',
  };

  it('projects the public-profile fields', () => {
    expect(buildPublicProfileResult(row)).toEqual({
      userId: 'user_1',
      username: 'alice',
      displayName: 'Alice',
      bio: 'hello',
      avatarUrl: 'https://cdn/avatar.png',
    });
  });

  it('NEVER includes an email field, even if the input row carries one', () => {
    // The DB row is widened deliberately: a regression could re-add email to
    // the SELECT. The projection must still drop it.
    const result = buildPublicProfileResult({
      ...row,
      // @ts-expect-error — email is intentionally not part of the input type
      email: 'alice@example.com',
    });
    expect(result).not.toHaveProperty('email');
    expect(Object.values(result)).not.toContain('alice@example.com');
  });

  it('preserves null profile fields without inventing values', () => {
    expect(
      buildPublicProfileResult({
        userId: 'u',
        username: null,
        displayName: null,
        bio: null,
        avatarUrl: null,
      })
    ).toEqual({
      userId: 'u',
      username: null,
      displayName: null,
      bio: null,
      avatarUrl: null,
    });
  });
});

describe('buildExactEmailMatchResult (M3 — exact-match branch may surface email)', () => {
  it('adds the email the caller already supplied to the public-profile base', () => {
    const base = buildPublicProfileResult({
      userId: 'user_2',
      username: 'bob',
      displayName: 'Bob',
      bio: null,
      avatarUrl: null,
    });
    expect(buildExactEmailMatchResult(base, 'bob@example.com')).toEqual({
      userId: 'user_2',
      username: 'bob',
      displayName: 'Bob',
      bio: null,
      avatarUrl: null,
      email: 'bob@example.com',
    });
  });
});

describe('resolveFindUser (L1 — /api/users/find existence + PII leak)', () => {
  const candidate = {
    id: 'target_1',
    name: 'Target',
    email: 'target@example.com',
    image: null,
  };

  it('collapses "no such account" into a uniform not-found', () => {
    expect(resolveFindUser(null, 'caller_1', false)).toEqual({ found: false });
  });

  it('collapses "account exists but caller cannot see them" into the SAME not-found', () => {
    // Indistinguishable from the null case above — that is the whole point.
    expect(resolveFindUser(candidate, 'caller_1', false)).toEqual({ found: false });
  });

  it('returns the user when the caller already shares context (visible)', () => {
    expect(resolveFindUser(candidate, 'caller_1', true)).toEqual({
      found: true,
      user: candidate,
    });
  });

  it('always lets a caller resolve their own account', () => {
    const self = { id: 'caller_1', name: 'Me', email: 'me@example.com', image: null };
    expect(resolveFindUser(self, 'caller_1', false)).toEqual({
      found: true,
      user: self,
    });
  });
});

describe('buildConnectionSearchResult (L2 — distinguishable relationship state)', () => {
  const target = {
    id: 'target_2',
    name: 'Carol',
    email: 'carol@example.com',
    displayName: 'Carol',
    bio: null,
    avatarUrl: null,
  };

  it('returns the actionable user only when one can actually be invited', () => {
    expect(
      buildConnectionSearchResult({ isSelf: false, target, existingStatus: null })
    ).toEqual({ user: target });
  });

  it('collapses self-search into the generic no-user response', () => {
    expect(
      buildConnectionSearchResult({ isSelf: true, target, existingStatus: null })
    ).toEqual({ user: null });
  });

  it('collapses "no account" into the generic no-user response', () => {
    expect(
      buildConnectionSearchResult({ isSelf: false, target: null, existingStatus: null })
    ).toEqual({ user: null });
  });

  it('collapses every existing-relationship state into the SAME generic response', () => {
    for (const existingStatus of ['PENDING', 'ACCEPTED', 'BLOCKED'] as const) {
      expect(
        buildConnectionSearchResult({ isSelf: false, target, existingStatus })
      ).toEqual({ user: null });
    }
  });

  it('never leaks a distinguishing error string', () => {
    const outcomes = [
      buildConnectionSearchResult({ isSelf: true, target, existingStatus: null }),
      buildConnectionSearchResult({ isSelf: false, target: null, existingStatus: null }),
      buildConnectionSearchResult({ isSelf: false, target, existingStatus: 'BLOCKED' }),
      buildConnectionSearchResult({ isSelf: false, target, existingStatus: 'PENDING' }),
    ];
    for (const outcome of outcomes) {
      expect(outcome).not.toHaveProperty('error');
      expect(outcome).toEqual({ user: null });
    }
  });
});
