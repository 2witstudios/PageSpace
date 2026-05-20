import { describe, it, expect } from 'vitest';
import { createInviteToken, verifyInviteToken } from '../invite-token';

const now = new Date('2026-05-06T12:00:00.000Z');

describe('createInviteToken', () => {
  it('given no expiryMinutes, should return null expiresAt (no expiry)', () => {
    const result = createInviteToken({ now });
    expect(result.expiresAt).toBeNull();
  });

  it('given expiryMinutes: null, should return null expiresAt', () => {
    const result = createInviteToken({ now, expiryMinutes: null });
    expect(result.expiresAt).toBeNull();
  });

  it('given expiryMinutes override, should honor it', () => {
    const result = createInviteToken({ now, expiryMinutes: 60 });
    expect(result.expiresAt!.getTime()).toBe(now.getTime() + 60 * 60 * 1000);
  });

  it('given expiryMinutes: 48*60, should set expiresAt 48 hours after now', () => {
    const result = createInviteToken({ now, expiryMinutes: 48 * 60 });
    const expected = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    expect(result.expiresAt!.getTime()).toBe(expected.getTime());
  });

  it('given a fresh call, should mint a token with the ps_invite_ prefix', () => {
    const { token } = createInviteToken({ now });
    expect(token.startsWith('ps_invite_')).toBe(true);
  });

  it('given a fresh call, should return tokenHash distinct from the raw token', () => {
    const { token, tokenHash } = createInviteToken({ now });
    expect(tokenHash).not.toBe(token);
    expect(tokenHash.length).toBeGreaterThan(0);
  });

  it('given two successive calls, should mint distinct tokens', () => {
    const a = createInviteToken({ now });
    const b = createInviteToken({ now });
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe('verifyInviteToken', () => {
  it('given a token paired with its own hash, should return true', () => {
    const { token, tokenHash } = createInviteToken({ now });
    expect(verifyInviteToken({ token, tokenHash })).toBe(true);
  });

  it('given a token paired with a different hash, should return false', () => {
    const { token } = createInviteToken({ now });
    const { tokenHash: otherHash } = createInviteToken({ now });
    expect(verifyInviteToken({ token, tokenHash: otherHash })).toBe(false);
  });

  it('given an empty token and a real hash, should return false', () => {
    const { tokenHash } = createInviteToken({ now });
    expect(verifyInviteToken({ token: '', tokenHash })).toBe(false);
  });

  it('given a tampered token (suffix mutated), should return false', () => {
    const { token, tokenHash } = createInviteToken({ now });
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(verifyInviteToken({ token: tampered, tokenHash })).toBe(false);
  });
});
