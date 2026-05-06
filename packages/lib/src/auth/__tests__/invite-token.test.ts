import { describe, it, expect } from 'vitest';
import {
  createInviteToken,
  verifyInviteToken,
  DEFAULT_INVITE_EXPIRY_MINUTES,
} from '../invite-token';
import { hashToken } from '../token-utils';

describe('createInviteToken', () => {
  it('returns a token with the ps_invite prefix', () => {
    const result = createInviteToken({ now: new Date('2026-05-06T00:00:00.000Z') });
    expect(result.token.startsWith('ps_invite_')).toBe(true);
  });

  it('returns a tokenHash equal to hashToken(token)', () => {
    const result = createInviteToken({ now: new Date('2026-05-06T00:00:00.000Z') });
    expect(result.tokenHash).toBe(hashToken(result.token));
  });

  it('defaults expiresAt to 48 hours after now', () => {
    const now = new Date('2026-05-06T00:00:00.000Z');
    const result = createInviteToken({ now });
    expect(result.expiresAt.getTime() - now.getTime()).toBe(
      DEFAULT_INVITE_EXPIRY_MINUTES * 60 * 1000
    );
  });

  it('respects a custom expiryMinutes parameter', () => {
    const now = new Date('2026-05-06T00:00:00.000Z');
    const result = createInviteToken({ now, expiryMinutes: 30 });
    expect(result.expiresAt).toEqual(new Date('2026-05-06T00:30:00.000Z'));
  });

  it('returns distinct tokens on consecutive calls', () => {
    const now = new Date('2026-05-06T00:00:00.000Z');
    const a = createInviteToken({ now });
    const b = createInviteToken({ now });
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe('verifyInviteToken', () => {
  it('returns true when hashToken(token) matches stored tokenHash', () => {
    const created = createInviteToken({ now: new Date('2026-05-06T00:00:00.000Z') });
    expect(
      verifyInviteToken({ token: created.token, tokenHash: created.tokenHash })
    ).toBe(true);
  });

  it('returns false when token does not match the stored hash', () => {
    const created = createInviteToken({ now: new Date('2026-05-06T00:00:00.000Z') });
    expect(
      verifyInviteToken({ token: 'ps_invite_wrong_token_value_here', tokenHash: created.tokenHash })
    ).toBe(false);
  });

  it('returns false when tokenHash is empty', () => {
    const created = createInviteToken({ now: new Date('2026-05-06T00:00:00.000Z') });
    expect(verifyInviteToken({ token: created.token, tokenHash: '' })).toBe(false);
  });

  it('returns false when token is empty', () => {
    const created = createInviteToken({ now: new Date('2026-05-06T00:00:00.000Z') });
    expect(verifyInviteToken({ token: '', tokenHash: created.tokenHash })).toBe(false);
  });
});
