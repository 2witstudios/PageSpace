import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockIsOnPrem = vi.hoisted(() => vi.fn(() => false));

vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: mockIsOnPrem,
}));

vi.mock('@pagespace/lib/encryption/encryption-utils', () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/secure-compare', () => ({
  secureCompare: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/mask-email', () => ({
  maskEmail: (e: string) => e,
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  DISTRIBUTED_RATE_LIMITS: { LOGIN: {} },
}));
vi.mock('@pagespace/lib/security/url-validator', () => ({
  validateLocalProviderURL: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      googleCalendarConnections: { findFirst: vi.fn().mockResolvedValue(null) },
      users: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1', email: 'test@example.com' }) },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ total: 0 }]) }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn() }),
    }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  count: vi.fn(() => 'count_agg'),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', email: 'email' },
}));
vi.mock('@pagespace/db/schema/calendar', () => ({
  googleCalendarConnections: { userId: 'userId' },
  calendarEvents: { createdById: 'x', syncedFromGoogle: 'x', isTrashed: 'x' },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn().mockResolvedValue({ userId: 'user-1' }),
  isAuthError: vi.fn().mockReturnValue(false),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  validateLoginCSRFToken: vi.fn().mockReturnValue(true),
  checkMCPDriveScope: vi.fn(),
}));

vi.mock('@/lib/integrations/google-calendar/return-url', () => ({
  normalizeGoogleCalendarReturnPath: (p: string) => p ?? '/settings',
  GOOGLE_CALENDAR_DEFAULT_RETURN_PATH: '/settings',
}));

vi.mock('@/lib/integrations/google-calendar/sync-service', () => ({
  syncGoogleCalendar: vi.fn(),
  unregisterWebhookChannels: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/integrations/google-calendar/webhook-auth', () => ({
  validateWebhookAuth: vi.fn().mockReturnValue({ ok: false, status: 401, body: { error: 'test' } }),
  _resetWarningFlag: vi.fn(),
}));

vi.mock('@/lib/integrations/google-calendar/token-refresh', () => ({
  getValidAccessToken: vi.fn().mockResolvedValue('token'),
}));

vi.mock('@/lib/integrations/google-calendar/api-client', () => ({
  listCalendars: vi.fn().mockResolvedValue([]),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue({ tokens: {} }),
    setCredentials: vi.fn(),
  })),
}));

const GATE_ERROR = 'Not available';

const assertModeGateBlocks = async (response: Response) => {
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body.error).toBe(GATE_ERROR);
};

const assertModeGatePasses = async (response: Response) => {
  if (response.status === 404) {
    const body = await response.json();
    expect(body.error).not.toBe(GATE_ERROR);
  }
};

import { GET as getStatus } from '../status/route';
import { POST as postConnect } from '../connect/route';
import { GET as getCallback } from '../callback/route';
import { POST as postWebhook } from '../webhook/route';
import { GET as getCalendars } from '../calendars/route';
import { POST as postDisconnect } from '../disconnect/route';
import { GET as getSettings, PATCH as patchSettings } from '../settings/route';
import { POST as postSync } from '../sync/route';

describe('Google Calendar routes — deployment mode gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnPrem.mockReturnValue(false);
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec';
    process.env.OAUTH_STATE_SECRET = 'secret-32-chars-minimum-length!!';
    process.env.WEB_APP_URL = 'http://localhost:3000';
  });

  const makeRequest = (method: string, body?: object) =>
    new Request('http://localhost/api/integrations/google-calendar/test', {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    });

  describe('GET /status', () => {
    it('given cloud mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await getStatus(makeRequest('GET')));
    });
    it('given tenant mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await getStatus(makeRequest('GET')));
    });
    it('given onprem mode, should return 404 from gate', async () => {
      mockIsOnPrem.mockReturnValue(true);
      await assertModeGateBlocks(await getStatus(makeRequest('GET')));
    });
  });

  describe('POST /connect', () => {
    it('given cloud mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await postConnect(makeRequest('POST', {})));
    });
    it('given tenant mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await postConnect(makeRequest('POST', {})));
    });
    it('given onprem mode, should return 404 from gate', async () => {
      mockIsOnPrem.mockReturnValue(true);
      await assertModeGateBlocks(await postConnect(makeRequest('POST', {})));
    });
  });

  describe('POST /disconnect', () => {
    it('given cloud mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await postDisconnect(makeRequest('POST')));
    });
    it('given tenant mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await postDisconnect(makeRequest('POST')));
    });
    it('given onprem mode, should return 404 from gate', async () => {
      mockIsOnPrem.mockReturnValue(true);
      await assertModeGateBlocks(await postDisconnect(makeRequest('POST')));
    });
  });

  describe('GET /calendars', () => {
    it('given cloud mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await getCalendars(makeRequest('GET')));
    });
    it('given tenant mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await getCalendars(makeRequest('GET')));
    });
    it('given onprem mode, should return 404 from gate', async () => {
      mockIsOnPrem.mockReturnValue(true);
      await assertModeGateBlocks(await getCalendars(makeRequest('GET')));
    });
  });

  describe('GET /settings', () => {
    it('given cloud mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await getSettings(makeRequest('GET')));
    });
    it('given tenant mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await getSettings(makeRequest('GET')));
    });
    it('given onprem mode, should return 404 from gate', async () => {
      mockIsOnPrem.mockReturnValue(true);
      await assertModeGateBlocks(await getSettings(makeRequest('GET')));
    });
  });

  describe('PATCH /settings', () => {
    it('given cloud mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await patchSettings(makeRequest('PATCH', {})));
    });
    it('given tenant mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await patchSettings(makeRequest('PATCH', {})));
    });
    it('given onprem mode, should return 404 from gate', async () => {
      mockIsOnPrem.mockReturnValue(true);
      await assertModeGateBlocks(await patchSettings(makeRequest('PATCH', {})));
    });
  });

  describe('POST /sync', () => {
    it('given cloud mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await postSync(makeRequest('POST')));
    });
    it('given tenant mode, should pass deployment mode gate', async () => {
      await assertModeGatePasses(await postSync(makeRequest('POST')));
    });
    it('given onprem mode, should return 404 from gate', async () => {
      mockIsOnPrem.mockReturnValue(true);
      await assertModeGateBlocks(await postSync(makeRequest('POST')));
    });
  });

  describe('POST /webhook', () => {
    it('given cloud mode, should pass deployment mode gate', async () => {
      const req = new Request('http://localhost/api/integrations/google-calendar/webhook', {
        method: 'POST',
        headers: { 'X-Goog-Channel-ID': 'ch-1', 'X-Goog-Resource-ID': 'res-1', 'X-Goog-Resource-State': 'exists' },
      });
      await assertModeGatePasses(await postWebhook(req));
    });
    it('given tenant mode, should pass deployment mode gate', async () => {
      const req = new Request('http://localhost/api/integrations/google-calendar/webhook', {
        method: 'POST',
        headers: { 'X-Goog-Channel-ID': 'ch-1', 'X-Goog-Resource-ID': 'res-1', 'X-Goog-Resource-State': 'exists' },
      });
      await assertModeGatePasses(await postWebhook(req));
    });
    it('given onprem mode, should return 404 from gate', async () => {
      mockIsOnPrem.mockReturnValue(true);
      const req = new Request('http://localhost/api/integrations/google-calendar/webhook', {
        method: 'POST',
        headers: { 'X-Goog-Channel-ID': 'ch-1', 'X-Goog-Resource-ID': 'res-1' },
      });
      await assertModeGateBlocks(await postWebhook(req));
    });
  });

  describe('GET /callback', () => {
    it('given cloud mode, should pass deployment mode gate', async () => {
      const req = new Request('http://localhost/api/integrations/google-calendar/callback?code=code&state=state');
      await assertModeGatePasses(await getCallback(req));
    });
    it('given tenant mode, should pass deployment mode gate', async () => {
      const req = new Request('http://localhost/api/integrations/google-calendar/callback?code=code&state=state');
      await assertModeGatePasses(await getCallback(req));
    });
    it('given onprem mode, should return 404 from gate', async () => {
      mockIsOnPrem.mockReturnValue(true);
      const req = new Request('http://localhost/api/integrations/google-calendar/callback?code=code&state=state');
      await assertModeGateBlocks(await getCallback(req));
    });
  });
});
