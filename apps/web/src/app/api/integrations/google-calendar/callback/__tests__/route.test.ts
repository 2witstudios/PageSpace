/**
 * Regression test for PII scrubbing in Google Calendar OAuth callback.
 * Asserts that googleEmail is masked in log metadata.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';

const mockGetToken = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    tokens: { access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600_000 },
  })
);
const mockSetCredentials = vi.hoisted(() => vi.fn());

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    getToken: mockGetToken,
    setCredentials: mockSetCredentials,
  })),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
  googleCalendarConnections: { userId: 'userId' },
}));

vi.mock('@pagespace/lib', () => ({
  isOnPrem: () => false,
  encrypt: vi.fn().mockResolvedValue('encrypted'),
  secureCompare: (a: string, b: string) => a === b,
}));

vi.mock('@pagespace/lib/server', async () => {
  const { maskEmail } = await vi.importActual<typeof import('@pagespace/lib/audit/mask-email')>(
    '@pagespace/lib/audit/mask-email'
  );
  return {
    loggers: {
      auth: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    },
    auditRequest: vi.fn(),
    maskEmail,
  };
});

vi.mock('@/lib/integrations/google-calendar/return-url', () => ({
  GOOGLE_CALENDAR_DEFAULT_RETURN_PATH: '/settings',
  normalizeGoogleCalendarReturnPath: (p: string) => p,
}));

import { GET } from '../route';
import { loggers } from '@pagespace/lib/server';

const SECRET = 'test-oauth-state-secret';

function createSignedState(data: { userId: string; returnUrl: string; timestamp: number }) {
  const sig = crypto.createHmac('sha256', SECRET).update(JSON.stringify(data)).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64');
}

describe('GET /api/integrations/google-calendar/callback', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      WEB_APP_URL: 'https://example.com',
      GOOGLE_OAUTH_CLIENT_ID: 'cid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
      OAUTH_STATE_SECRET: SECRET,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  describe('PII scrub', () => {
    it('masks googleEmail in "email not verified" warn log', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          email: 'jane@example.com',
          id: 'gid-1',
          verified_email: false,
        }),
      }) as never;

      const state = createSignedState({
        userId: 'user-1',
        returnUrl: '/settings',
        timestamp: Date.now(),
      });
      const url = new URL('http://localhost/api/integrations/google-calendar/callback');
      url.searchParams.set('code', 'auth-code');
      url.searchParams.set('state', state);

      await GET(new Request(url.toString()));

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Google account email is not verified',
        { googleEmail: 'ja***@example.com' }
      );
    });
  });
});
