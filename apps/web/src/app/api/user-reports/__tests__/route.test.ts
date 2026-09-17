import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

const { values, sendEmail, checkDistributedRateLimit } = vi.hoisted(() => ({
  values: vi.fn().mockResolvedValue(undefined),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  checkDistributedRateLimit: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({ db: { insert: vi.fn(() => ({ values })) } }));
vi.mock('@pagespace/db/schema/feedback', () => ({ feedbackSubmissions: {} }));
vi.mock('@pagespace/lib/services/email-service', () => ({ sendEmail }));
vi.mock('@pagespace/lib/email-templates/FeedbackNotificationEmail', () => ({ FeedbackNotificationEmail: vi.fn(() => null) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } } }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS: { CONTACT_FORM: { maxRequests: 5, windowMs: 3600000 } },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';

const ME = 'user_me';
const auth = (): SessionAuthResult => ({
  userId: ME, tokenVersion: 0, tokenType: 'session', sessionId: 's', role: 'user', adminRoleVersion: 0,
});
const call = (body: unknown) =>
  POST(new Request('http://localhost/api/user-reports', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/user-reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth());
    checkDistributedRateLimit.mockResolvedValue({ allowed: true });
  });

  it('given a report about another user, should store it and notify the team with the reported user and conversation', async () => {
    const res = await call({ targetUserId: 'user_abuser', conversationId: 'conv_1', reason: 'Harassing messages' });
    expect(res.status).toBe(201);
    const stored = values.mock.calls[0][0] as { userId: string; message: string; pageUrl: string | null };
    expect(stored.userId).toBe(ME);
    expect(stored.message).toMatch(/user_abuser/);
    expect(stored.message).toMatch(/Harassing messages/);
    expect(stored.pageUrl).toBe('/dashboard/dms/conv_1');
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/Report/) }));
  });

  it('given a report without a reason, should refuse', async () => {
    const res = await call({ targetUserId: 'user_abuser', reason: '' });
    expect(res.status).toBe(400);
    expect(values).not.toHaveBeenCalled();
  });

  it('given a user reporting themselves, should refuse', async () => {
    const res = await call({ targetUserId: ME, reason: 'x' });
    expect(res.status).toBe(400);
    expect(values).not.toHaveBeenCalled();
  });

  it('given too many reports, should refuse with 429', async () => {
    checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 60 });
    const res = await call({ targetUserId: 'user_abuser', reason: 'spam' });
    expect(res.status).toBe(429);
    expect(values).not.toHaveBeenCalled();
  });

  it('given no session, should refuse', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) });
    const res = await call({ targetUserId: 'user_abuser', reason: 'spam' });
    expect(res.status).toBe(401);
  });
});
