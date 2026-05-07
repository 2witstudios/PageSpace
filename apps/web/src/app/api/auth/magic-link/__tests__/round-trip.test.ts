/**
 * Round-trip integration test for magic-link next= honouring.
 *
 * Exercises the full chain: POST /send → real pipe → real adapter →
 * captured email URL → GET /verify → redirect.
 *
 * Mocks only the IO boundaries: database (token persist + read), email
 * transport, session service, and verification utilities. The pipe,
 * adapter URL composition, send route, and verify route all run for real
 * so a plumbing break anywhere in the chain fails this test.
 */

// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const dbInsertMock = vi.hoisted(() =>
  vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
);
const sendEmailMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const generateTokenMock = vi.hoisted(() =>
  vi.fn(() => ({ token: 'tok_round_trip', hash: 'tok_hash', tokenPrefix: 'tok_' })),
);
const verifyMagicLinkTokenMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    data: { userId: 'user_test', isNewUser: false },
  }),
);
const loadUserAccountByEmailMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: 'user_test', suspendedAt: null }),
);

vi.mock('@pagespace/db/db', () => ({ db: { insert: dbInsertMock } }));
vi.mock('@pagespace/db/schema/auth', () => ({ verificationTokens: {} }));
vi.mock('@pagespace/lib/services/email-service', () => ({ sendEmail: sendEmailMock }));
vi.mock('@pagespace/lib/email-templates/MagicLinkEmail', () => ({
  MagicLinkEmail: () => null,
}));
vi.mock('@pagespace/lib/auth/token-utils', () => ({ generateToken: generateTokenMock }));
vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  verifyMagicLinkToken: verifyMagicLinkTokenMock,
}));
vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: { loadUserAccountByEmail: loadUserAccountByEmailMock },
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 4,
    retryAfter: undefined,
  }),
  DISTRIBUTED_RATE_LIMITS: {
    MAGIC_LINK: { maxAttempts: 5, windowMs: 900000, progressiveDelay: false },
  },
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_round_trip'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'sess_round_trip',
      userId: 'user_test',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock('@pagespace/lib/auth/csrf-utils', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
}));
vi.mock('@pagespace/lib/auth/constants', () => ({
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));
vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  markEmailVerified: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },
}));
vi.mock('@/lib/auth', () => ({
  validateLoginCSRFToken: vi.fn().mockReturnValue(true),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));
vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));
vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue(null),
}));
vi.mock('cookie', () => ({
  parse: vi.fn().mockReturnValue({ login_csrf: 'valid-csrf-token' }),
}));

import { POST as sendPost } from '../send/route';
import { GET as verifyGet } from '../verify/route';

const buildSendRequest = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/auth/magic-link/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Login-CSRF-Token': 'valid-csrf-token',
      Cookie: 'login_csrf=valid-csrf-token',
    },
    body: JSON.stringify(body),
  });

const extractUrlFromEmailCall = (): string => {
  expect(sendEmailMock).toHaveBeenCalledOnce();
  const args = sendEmailMock.mock.calls[0]?.[0] as {
    react: { props: { magicLinkUrl: string } };
  };
  return args.react.props.magicLinkUrl;
};

describe('magic-link round-trip — next honoured end-to-end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('WEB_APP_URL', 'https://example.com');
    vi.stubEnv('NODE_ENV', 'test');
    sendEmailMock.mockResolvedValue(undefined);
    generateTokenMock.mockReturnValue({
      token: 'tok_round_trip',
      hash: 'tok_hash',
      tokenPrefix: 'tok_',
    });
    verifyMagicLinkTokenMock.mockResolvedValue({
      ok: true,
      data: { userId: 'user_test', isNewUser: false },
    });
    loadUserAccountByEmailMock.mockResolvedValue({ id: 'user_test', suspendedAt: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('safe next on send body lands the user on that path after verify', async () => {
    const sendResp = await sendPost(
      buildSendRequest({ email: 'user@example.com', next: '/dashboard/drive_abc' }),
    );
    expect(sendResp.status).toBe(200);

    const url = extractUrlFromEmailCall();
    expect(url).toContain('token=tok_round_trip');
    expect(url).toContain('next=%2Fdashboard%2Fdrive_abc');

    const verifyResp = await verifyGet(new Request(url, { method: 'GET' }));
    expect(verifyResp.status).toBe(302);
    const location = verifyResp.headers.get('Location')!;
    expect(location).toContain('/dashboard/drive_abc');
    expect(location).toContain('auth=success');
  });

  it('unsafe next on send body is stripped at the boundary; verify URL has no next', async () => {
    const sendResp = await sendPost(
      buildSendRequest({ email: 'user@example.com', next: '//evil.com/phish' }),
    );
    expect(sendResp.status).toBe(200);

    const url = extractUrlFromEmailCall();
    expect(url).not.toContain('next=');
    expect(url).not.toContain('evil.com');

    const verifyResp = await verifyGet(new Request(url, { method: 'GET' }));
    const location = verifyResp.headers.get('Location')!;
    expect(location).toContain('/dashboard');
    expect(location).not.toContain('evil.com');
  });

  it('safe next on send body, but tampered to unsafe in the email link, is rejected at verify', async () => {
    await sendPost(
      buildSendRequest({ email: 'user@example.com', next: '/dashboard/drive_abc' }),
    );
    extractUrlFromEmailCall();

    // Simulate a tampered email link — attacker swaps next= for an open
    // redirect target after the email is sent. Verify route must catch it.
    const tamperedUrl =
      'https://example.com/api/auth/magic-link/verify?token=tok_round_trip&next=' +
      encodeURIComponent('//evil.com/phish');

    const verifyResp = await verifyGet(new Request(tamperedUrl, { method: 'GET' }));
    const location = verifyResp.headers.get('Location')!;
    expect(location).toContain('/dashboard');
    expect(location).not.toContain('evil.com');
  });
});
