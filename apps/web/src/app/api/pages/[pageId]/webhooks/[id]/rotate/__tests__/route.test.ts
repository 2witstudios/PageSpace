import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v0Scheme, DEFAULT_REPLAY_WINDOW_MS } from '@pagespace/lib/security/webhook-signature';

const mockAuthenticateRequestWithOptions = vi.fn();
const mockIsAuthError = vi.fn();
const mockCanManagePageWebhooks = vi.fn();
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequestWithOptions(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
  canManagePageWebhooks: (...args: unknown[]) => mockCanManagePageWebhooks(...args),
}));

const mockFindFirst = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateReturning = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pageWebhooks: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
    update: () => ({
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);
        return {
          where: () => ({
            returning: () => mockUpdateReturning(...args),
          }),
        };
      },
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
  and: (...args: unknown[]) => ({ and: args }),
}));
vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { id: 'pageWebhooks.id', pageId: 'pageWebhooks.pageId' },
}));

const mockEncryptField = vi.fn(async (v: string) => `encrypted(${v})`);
vi.mock('@pagespace/lib/encryption/field-crypto', () => ({
  encryptField: (...args: [string]) => mockEncryptField(...args),
}));

const mockAuditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { POST } from '../route';

const SESSION_AUTH = { userId: 'user-1', kind: 'session' };
const PARAMS = { params: Promise.resolve({ pageId: 'page-1', id: 'wh-1' }) };
const WEBHOOK_ROW = {
  id: 'wh-1',
  pageId: 'page-1',
  name: 'Deploys',
  webhookToken: 'tok-abc',
  webhookSecretEncrypted: 'encrypted(old-secret)',
  isEnabled: true,
  createdBy: 'user-1',
};

function makeRequest(): Request {
  return new Request('https://example.com/api/pages/page-1/webhooks/wh-1/rotate', { method: 'POST' });
}

/** What the mocked encryptField stored, inverted — stands in for intake's decryptField. */
function storedPlaintext(): string {
  const [setArg] = mockUpdateSet.mock.calls[0] as [{ webhookSecretEncrypted: string }];
  const match = setArg.webhookSecretEncrypted.match(/^encrypted\((.+)\)$/);
  if (!match) throw new Error('stored secret was not encrypted');
  return match[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequestWithOptions.mockResolvedValue(SESSION_AUTH);
  mockIsAuthError.mockReturnValue(false);
  mockCanManagePageWebhooks.mockResolvedValue(true);
  mockFindFirst.mockResolvedValue(WEBHOOK_ROW);
  mockUpdateReturning.mockImplementation((setArg: Partial<typeof WEBHOOK_ROW>) => [{ ...WEBHOOK_ROW, ...setArg }]);
});

describe('POST /api/pages/[pageId]/webhooks/[id]/rotate', () => {
  it('mints a new 256-bit secret, encrypts it at rest, and returns the plaintext exactly once', async () => {
    const response = await POST(makeRequest(), PARAMS);
    expect(response.status).toBe(200);
    const body = await response.json();

    // 32 random bytes as base64url — 43 chars, no padding.
    expect(body.webhookSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.webhookSecret).not.toBe('old-secret');

    // At rest: only the encrypted form of the new secret is written.
    expect(mockEncryptField).toHaveBeenCalledWith(body.webhookSecret);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith({ webhookSecretEncrypted: `encrypted(${body.webhookSecret})` });
  });

  it('keeps the webhookToken (and URL) unchanged and never writes it', async () => {
    const response = await POST(makeRequest(), PARAMS);
    const body = await response.json();
    expect(body.webhook.webhookToken).toBe('tok-abc');
    const [setArg] = mockUpdateSet.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(setArg)).toEqual(['webhookSecretEncrypted']);
  });

  it('strips the encrypted secret from the returned webhook row', async () => {
    const response = await POST(makeRequest(), PARAMS);
    const body = await response.json();
    expect(body.webhook.webhookSecretEncrypted).toBeUndefined();
    expect(JSON.stringify(body.webhook)).not.toContain('encrypted(');
  });

  it('after rotation the OLD secret no longer verifies and the NEW secret does', async () => {
    const response = await POST(makeRequest(), PARAMS);
    const { webhookSecret: newSecret } = await response.json();

    // Intake decrypts the stored secret and verifies the delivery against it.
    const storedSecret = storedPlaintext();
    expect(storedSecret).toBe(newSecret);

    const nowMs = 1_700_000_000_000;
    const timestampSeconds = Math.floor(nowMs / 1000);
    const rawBody = '{"text":"deploy finished"}';
    const verifyAgainstStored = (signature: string) =>
      v0Scheme.verify({
        secret: storedSecret,
        signature,
        timestamp: String(timestampSeconds),
        rawBody,
        nowMs,
        replayWindowMs: DEFAULT_REPLAY_WINDOW_MS,
      });

    const signedWithOld = v0Scheme.sign('old-secret', timestampSeconds, rawBody);
    const signedWithNew = v0Scheme.sign(newSecret, timestampSeconds, rawBody);
    expect(verifyAgainstStored(signedWithOld)).toBe(false);
    expect(verifyAgainstStored(signedWithNew)).toBe(true);
  });

  it('audits the rotation as a data.write with operation rotate', async () => {
    await POST(makeRequest(), PARAMS);
    expect(mockAuditRequest).toHaveBeenCalledWith(expect.any(Request), {
      eventType: 'data.write',
      userId: 'user-1',
      resourceType: 'page_webhook',
      resourceId: 'wh-1',
      details: { operation: 'rotate', pageId: 'page-1' },
    });
  });

  it('rejects a non-owner/admin with 403 without reading or rotating', async () => {
    mockCanManagePageWebhooks.mockResolvedValue(false);
    const response = await POST(makeRequest(), PARAMS);
    expect(response.status).toBe(403);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('returns 404 for a webhook not owned by this page, without rotating', async () => {
    mockFindFirst.mockResolvedValue(null);
    const response = await POST(makeRequest(), PARAMS);
    expect(response.status).toBe(404);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('propagates an auth error unchanged', async () => {
    const authError = { error: new Response(null, { status: 401 }) };
    mockAuthenticateRequestWithOptions.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);
    const response = await POST(makeRequest(), PARAMS);
    expect(response.status).toBe(401);
    expect(mockCanManagePageWebhooks).not.toHaveBeenCalled();
  });
});
