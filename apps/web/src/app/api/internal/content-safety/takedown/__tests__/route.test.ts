import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSelectRows = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => mockSelectRows() }) }) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', role: 'role' } }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { security: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } },
}));

const mockExecuteTakedown = vi.fn();
vi.mock('@/lib/content-safety/takedown-service', () => {
  class TakedownRequestError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  return {
    TakedownRequestError,
    executeTakedown: (...args: unknown[]) => mockExecuteTakedown(...args),
  };
});

import { POST } from '../route';
import { TakedownRequestError } from '@/lib/content-safety/takedown-service';
import { loggers } from '@pagespace/lib/logging/logger-config';

const SECRET = 'service-secret-that-is-long-enough-123';
const HASH = 'a'.repeat(64);
const BODY = { action: 'global', contentHash: HASH, category: 'csam', reason: 'hash match' };

const request = (headers: Record<string, string>, body: unknown = BODY) =>
  new Request('http://web:3000/api/internal/content-safety/takedown', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const authed = { 'x-service-secret': SECRET, 'x-service-user-id': 'admin-1' };

describe('POST /api/internal/content-safety/takedown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SERVICE_API_SECRET', SECRET);
    mockSelectRows.mockResolvedValue([{ role: 'admin' }]);
    mockExecuteTakedown.mockResolvedValue({ action: 'global', caseId: 'case-1', status: 'actioned' });
  });

  describe('service auth', () => {
    it('refuses a request with no service secret', async () => {
      const response = await POST(request({ 'x-service-user-id': 'admin-1' }));
      expect(response.status).toBe(403);
      expect(mockExecuteTakedown).not.toHaveBeenCalled();
    });

    it('refuses a wrong secret', async () => {
      const response = await POST(request({ ...authed, 'x-service-secret': 'wrong' }));
      expect(response.status).toBe(403);
      expect(mockExecuteTakedown).not.toHaveBeenCalled();
    });

    it('fails closed when SERVICE_API_SECRET is not configured, even for an empty header', async () => {
      vi.stubEnv('SERVICE_API_SECRET', '');
      const response = await POST(request({ ...authed, 'x-service-secret': '' }));
      expect(response.status).toBe(403);
      expect(mockExecuteTakedown).not.toHaveBeenCalled();
    });

    it('refuses a request with no acting user', async () => {
      const response = await POST(request({ 'x-service-secret': SECRET }));
      expect(response.status).toBe(400);
      expect(mockExecuteTakedown).not.toHaveBeenCalled();
    });

    it('refuses an acting user who is not an admin in the database', async () => {
      mockSelectRows.mockResolvedValue([{ role: 'user' }]);
      expect((await POST(request(authed))).status).toBe(403);

      mockSelectRows.mockResolvedValue([]);
      expect((await POST(request(authed))).status).toBe(403);
      expect(mockExecuteTakedown).not.toHaveBeenCalled();
    });
  });

  it('runs a valid request as the acting admin and returns its result', async () => {
    const response = await POST(request(authed));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: 'global', caseId: 'case-1', status: 'actioned' });
    expect(mockExecuteTakedown).toHaveBeenCalledWith(BODY, 'admin-1');
  });

  it('returns 200 with the failed step when a step fails, so the caller can offer resume', async () => {
    mockExecuteTakedown.mockResolvedValue({ action: 'global', caseId: 'case-1', status: 'open', failedStep: 'delete_public', error: 'S3 down' });
    const response = await POST(request(authed));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'open', failedStep: 'delete_public' });
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a missing reason', { ...BODY, reason: '' }],
    ['a global takedown under the policy category', { ...BODY, category: 'policy' }],
    ['an unknown action', { action: 'nuke' }],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await POST(request(authed, body));
    expect(response.status).toBe(400);
    expect(mockExecuteTakedown).not.toHaveBeenCalled();
  });

  it('maps a request the service cannot act on to its status', async () => {
    mockExecuteTakedown.mockRejectedValue(new TakedownRequestError('Case not found', 404));
    const response = await POST(request(authed, { action: 'resume', caseId: 'missing' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Case not found' });
  });

  it('answers 500 without leaking the error, and logs no hash or reason', async () => {
    mockExecuteTakedown.mockRejectedValue(new Error(`boom at files/${HASH}/original`));
    const response = await POST(request(authed));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Takedown failed' });
    const [, , meta] = vi.mocked(loggers.security.error).mock.calls[0];
    expect(meta).toEqual({ action: 'global' });
  });
});
