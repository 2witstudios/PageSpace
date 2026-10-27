import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  decideCodeExchange,
  decideDevicePoll,
  decideDeviceApproval,
  type AuthorizationCodeRecord,
  type DeviceCodeRecord,
} from '../code-lifecycle';

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

const NOW = new Date('2026-07-03T12:00:00.000Z');
const VERIFIER = 'a-valid-code-verifier-value-1234567890-abcdef';
const CHALLENGE = s256(VERIFIER);

function authCode(overrides: Partial<AuthorizationCodeRecord> = {}): AuthorizationCodeRecord {
  return {
    clientId: 'pagespace-cli',
    userId: 'user-1',
    scopes: ['drive:read'],
    redirectUri: 'http://127.0.0.1:51000/callback',
    codeChallenge: CHALLENGE,
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
    ...overrides,
  };
}

describe('decideCodeExchange', () => {
  it('returns ok(grant) for a valid, unconsumed, unexpired code with matching redirect + PKCE', () => {
    const record = authCode();
    const decision = decideCodeExchange(
      record,
      { redirectUri: record.redirectUri, codeVerifier: VERIFIER },
      NOW,
    );
    expect(decision).toEqual({
      status: 'ok',
      grant: { clientId: 'pagespace-cli', userId: 'user-1', scopes: ['drive:read'] },
    });
  });

  it('fails closed exactly at the expiry boundary', () => {
    const record = authCode({ expiresAt: NOW });
    const decision = decideCodeExchange(
      record,
      { redirectUri: record.redirectUri, codeVerifier: VERIFIER },
      NOW,
    );
    expect(decision).toEqual({ status: 'expired' });
  });

  it('fails when now is after expiresAt', () => {
    const record = authCode({ expiresAt: new Date(NOW.getTime() - 1) });
    const decision = decideCodeExchange(
      record,
      { redirectUri: record.redirectUri, codeVerifier: VERIFIER },
      NOW,
    );
    expect(decision).toEqual({ status: 'expired' });
  });

  it('succeeds one tick before expiry', () => {
    const record = authCode({ expiresAt: new Date(NOW.getTime() + 1) });
    const decision = decideCodeExchange(
      record,
      { redirectUri: record.redirectUri, codeVerifier: VERIFIER },
      NOW,
    );
    expect(decision.status).toBe('ok');
  });

  it('returns already_consumed with a revoke signal for a double-consume attempt', () => {
    const record = authCode({ consumedAt: new Date(NOW.getTime() - 1000) });
    const decision = decideCodeExchange(
      record,
      { redirectUri: record.redirectUri, codeVerifier: VERIFIER },
      NOW,
    );
    expect(decision).toEqual({ status: 'already_consumed', revokeIssuedTokens: true });
  });

  it('treats already_consumed as the highest-priority failure (wins over expired)', () => {
    const record = authCode({
      consumedAt: new Date(NOW.getTime() - 1000),
      expiresAt: new Date(NOW.getTime() - 500),
    });
    const decision = decideCodeExchange(
      record,
      { redirectUri: 'http://wrong', codeVerifier: 'wrong-verifier' },
      NOW,
    );
    expect(decision).toEqual({ status: 'already_consumed', revokeIssuedTokens: true });
  });

  it('rejects an exact-match-required redirect_uri mismatch', () => {
    const record = authCode();
    const decision = decideCodeExchange(
      record,
      { redirectUri: 'http://127.0.0.1:51000/callback/', codeVerifier: VERIFIER },
      NOW,
    );
    expect(decision).toEqual({ status: 'redirect_mismatch' });
  });

  it('checks redirect_uri before PKCE (redirect_mismatch wins over pkce_failed)', () => {
    const record = authCode();
    const decision = decideCodeExchange(
      record,
      { redirectUri: 'http://attacker.example/callback', codeVerifier: 'totally-wrong' },
      NOW,
    );
    expect(decision).toEqual({ status: 'redirect_mismatch' });
  });

  it('checks expiry before redirect_uri (expired wins over redirect_mismatch)', () => {
    const record = authCode({ expiresAt: new Date(NOW.getTime() - 1) });
    const decision = decideCodeExchange(
      record,
      { redirectUri: 'http://attacker.example/callback', codeVerifier: VERIFIER },
      NOW,
    );
    expect(decision).toEqual({ status: 'expired' });
  });

  it('rejects a PKCE verifier that does not hash to the stored challenge', () => {
    const record = authCode();
    const decision = decideCodeExchange(
      record,
      { redirectUri: record.redirectUri, codeVerifier: 'not-the-right-verifier' },
      NOW,
    );
    expect(decision).toEqual({ status: 'pkce_failed' });
  });

  it('rejects an empty PKCE verifier', () => {
    const record = authCode();
    const decision = decideCodeExchange(
      record,
      { redirectUri: record.redirectUri, codeVerifier: '' },
      NOW,
    );
    expect(decision).toEqual({ status: 'pkce_failed' });
  });
});

function deviceCode(
  status: 'pending' | 'approved' | 'denied',
  overrides: Record<string, unknown> = {},
): DeviceCodeRecord {
  const base = {
    clientId: 'pagespace-cli',
    scopes: ['drive:read'],
    expiresAt: new Date(NOW.getTime() + 1_800_000),
    lastPolledAt: null,
    pollIntervalSeconds: 5,
    ...overrides,
  };
  if (status === 'approved') {
    return { status: 'approved', approvedUserId: 'user-1', ...base } as DeviceCodeRecord;
  }
  return { status, ...base } as DeviceCodeRecord;
}

describe('decideDevicePoll', () => {
  it('returns authorization_pending for a fresh pending code with no prior poll', () => {
    const record = deviceCode('pending');
    expect(decideDevicePoll(record, NOW)).toEqual({ status: 'authorization_pending' });
  });

  it('returns slow_down when polling faster than the interval', () => {
    const record = deviceCode('pending', { lastPolledAt: new Date(NOW.getTime() - 4000) });
    expect(decideDevicePoll(record, NOW)).toEqual({ status: 'slow_down' });
  });

  it('does not slow_down exactly at the poll interval boundary', () => {
    const record = deviceCode('pending', { lastPolledAt: new Date(NOW.getTime() - 5000) });
    expect(decideDevicePoll(record, NOW)).toEqual({ status: 'authorization_pending' });
  });

  it('allows polling once more than the interval has elapsed', () => {
    const record = deviceCode('pending', { lastPolledAt: new Date(NOW.getTime() - 6000) });
    expect(decideDevicePoll(record, NOW)).toEqual({ status: 'authorization_pending' });
  });

  it('fails closed exactly at the expiry boundary regardless of status', () => {
    const record = deviceCode('pending', { expiresAt: NOW });
    expect(decideDevicePoll(record, NOW)).toEqual({ status: 'expired_token' });
  });

  it('fails when now is after expiresAt', () => {
    const record = deviceCode('pending', { expiresAt: new Date(NOW.getTime() - 1) });
    expect(decideDevicePoll(record, NOW)).toEqual({ status: 'expired_token' });
  });

  it('returns expired_token even for an approved-but-expired code', () => {
    const record = deviceCode('approved', { expiresAt: NOW });
    expect(decideDevicePoll(record, NOW)).toEqual({ status: 'expired_token' });
  });

  it('returns access_denied for a denied code', () => {
    const record = deviceCode('denied');
    expect(decideDevicePoll(record, NOW)).toEqual({ status: 'access_denied' });
  });

  it('returns ok(grant) for an approved code', () => {
    const record = deviceCode('approved');
    expect(decideDevicePoll(record, NOW)).toEqual({
      status: 'ok',
      grant: { clientId: 'pagespace-cli', userId: 'user-1', scopes: ['drive:read'] },
    });
  });

  it('delivers an approved grant immediately even if polled faster than the interval', () => {
    const record = deviceCode('approved', { lastPolledAt: new Date(NOW.getTime() - 1) });
    expect(decideDevicePoll(record, NOW)).toEqual({
      status: 'ok',
      grant: { clientId: 'pagespace-cli', userId: 'user-1', scopes: ['drive:read'] },
    });
  });

  it('delivers access_denied immediately even if polled faster than the interval', () => {
    const record = deviceCode('denied', { lastPolledAt: new Date(NOW.getTime() - 1) });
    expect(decideDevicePoll(record, NOW)).toEqual({ status: 'access_denied' });
  });
});

describe('decideDeviceApproval', () => {
  it('transitions pending -> approved and returns the grant', () => {
    const record = deviceCode('pending');
    const decision = decideDeviceApproval(record, 'approve', 'user-1', NOW);
    expect(decision).toEqual({
      status: 'approved',
      grant: { clientId: 'pagespace-cli', userId: 'user-1', scopes: ['drive:read'] },
    });
  });

  it('transitions pending -> denied', () => {
    const record = deviceCode('pending');
    const decision = decideDeviceApproval(record, 'deny', 'user-1', NOW);
    expect(decision).toEqual({ status: 'denied' });
  });

  it('rejects a repeat approve on an already-approved record', () => {
    const record = deviceCode('approved');
    const decision = decideDeviceApproval(record, 'approve', 'user-1', NOW);
    expect(decision).toEqual({ status: 'already_settled', existingStatus: 'approved' });
  });

  it('rejects approve-after-deny (settled record wins regardless of the new action)', () => {
    const record = deviceCode('denied');
    const decision = decideDeviceApproval(record, 'approve', 'user-1', NOW);
    expect(decision).toEqual({ status: 'already_settled', existingStatus: 'denied' });
  });

  it('rejects a repeat deny on an already-denied record', () => {
    const record = deviceCode('denied');
    const decision = decideDeviceApproval(record, 'deny', 'user-1', NOW);
    expect(decision).toEqual({ status: 'already_settled', existingStatus: 'denied' });
  });

  it('rejects deny-after-approve', () => {
    const record = deviceCode('approved');
    const decision = decideDeviceApproval(record, 'deny', 'user-1', NOW);
    expect(decision).toEqual({ status: 'already_settled', existingStatus: 'approved' });
  });

  it('fails closed exactly at the expiry boundary for a still-pending record', () => {
    const record = deviceCode('pending', { expiresAt: NOW });
    const decision = decideDeviceApproval(record, 'approve', 'user-1', NOW);
    expect(decision).toEqual({ status: 'expired' });
  });

  it('fails when now is after expiresAt for a still-pending record', () => {
    const record = deviceCode('pending', { expiresAt: new Date(NOW.getTime() - 1) });
    const decision = decideDeviceApproval(record, 'approve', 'user-1', NOW);
    expect(decision).toEqual({ status: 'expired' });
  });

  it('succeeds one tick before expiry', () => {
    const record = deviceCode('pending', { expiresAt: new Date(NOW.getTime() + 1) });
    const decision = decideDeviceApproval(record, 'approve', 'user-1', NOW);
    expect(decision.status).toBe('approved');
  });
});
