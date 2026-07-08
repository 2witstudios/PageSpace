/**
 * Unit tests for the users-list pagination/search/sort helpers.
 * These run in Node after PII decryption (name/email are ciphertext in SQL).
 */

import { describe, it, expect } from 'vitest';
import { parseListUsersParams, matchesSearch, compareUsers, isDormant, DORMANT_DAYS, type SortableUser } from '../list-params';

function url(query = ''): URL {
  return new URL(`http://localhost/api/admin/users${query}`);
}

function user(overrides: Partial<SortableUser> = {}): SortableUser {
  return {
    name: 'Alice',
    email: 'alice@example.com',
    currentAiProvider: 'openai',
    subscriptionTier: 'free',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActiveAt: null,
    ...overrides,
  };
}

describe('parseListUsersParams', () => {
  it('applies defaults when no params are given', () => {
    expect(parseListUsersParams(url())).toEqual({
      limit: 25,
      offset: 0,
      q: '',
      sort: 'name',
      dir: 'asc',
    });
  });

  it('parses valid params', () => {
    const parsed = parseListUsersParams(url('?limit=50&offset=100&q=%20jane%20&sort=lastActive&dir=desc&dormant=true&suspended=true'));
    expect(parsed).toEqual({
      limit: 50,
      offset: 100,
      q: 'jane',
      sort: 'lastActive',
      dir: 'desc',
      dormant: 'true',
      suspended: 'true',
    });
  });

  it('rejects out-of-range or malformed params', () => {
    expect(parseListUsersParams(url('?limit=0'))).toBeNull();
    expect(parseListUsersParams(url('?limit=101'))).toBeNull();
    expect(parseListUsersParams(url('?limit=abc'))).toBeNull();
    expect(parseListUsersParams(url('?offset=-1'))).toBeNull();
    expect(parseListUsersParams(url('?sort=password'))).toBeNull();
    expect(parseListUsersParams(url('?dir=sideways'))).toBeNull();
  });
});

describe('matchesSearch', () => {
  const alice = user();

  it('matches on name, email, and AI provider (case-insensitive)', () => {
    expect(matchesSearch(alice, 'ali')).toBe(true);
    expect(matchesSearch(alice, 'alice@EXAMPLE'.toLowerCase())).toBe(true);
    expect(matchesSearch(alice, 'openai')).toBe(true);
    expect(matchesSearch(alice, 'bob')).toBe(false);
  });

  it('matches everything on an empty query and tolerates null fields', () => {
    expect(matchesSearch(alice, '')).toBe(true);
    expect(matchesSearch(user({ name: null, email: null, currentAiProvider: null }), 'x')).toBe(false);
  });
});

describe('compareUsers', () => {
  it('sorts by name ascending', () => {
    const cmp = compareUsers('name');
    expect(cmp(user({ name: 'Alice' }), user({ name: 'Bob' }))).toBeLessThan(0);
  });

  it('sorts by createdAt', () => {
    const cmp = compareUsers('created');
    const older = user({ createdAt: new Date('2025-01-01') });
    const newer = user({ createdAt: new Date('2026-01-01') });
    expect(cmp(older, newer)).toBeLessThan(0);
  });

  it('sorts by lastActive with never-active users as oldest', () => {
    const cmp = compareUsers('lastActive');
    const never = user({ lastActiveAt: null });
    const recent = user({ lastActiveAt: new Date() });
    expect(cmp(never, recent)).toBeLessThan(0);
  });

  it('sorts by tier rank (free < pro < founder < business)', () => {
    const cmp = compareUsers('tier');
    expect(cmp(user({ subscriptionTier: 'free' }), user({ subscriptionTier: 'pro' }))).toBeLessThan(0);
    expect(cmp(user({ subscriptionTier: 'business' }), user({ subscriptionTier: 'founder' }))).toBeGreaterThan(0);
    expect(cmp(user({ subscriptionTier: 'pro' }), user({ subscriptionTier: 'pro' }))).toBe(0);
  });
});

describe('isDormant', () => {
  const now = Date.now();

  it('treats never-active users as dormant', () => {
    expect(isDormant(null, now)).toBe(true);
  });

  it('uses the 30-day threshold', () => {
    const justUnder = new Date(now - (DORMANT_DAYS * 24 * 60 * 60 * 1000 - 1000));
    const justOver = new Date(now - (DORMANT_DAYS * 24 * 60 * 60 * 1000 + 1000));
    expect(isDormant(justUnder, now)).toBe(false);
    expect(isDormant(justOver, now)).toBe(true);
  });
});
