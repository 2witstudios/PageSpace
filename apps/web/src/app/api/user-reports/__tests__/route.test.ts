import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

const { values, sendEmail, checkDistributedRateLimit, fileReport } = vi.hoisted(() => ({
  values: vi.fn().mockResolvedValue(undefined),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  checkDistributedRateLimit: vi.fn(),
  fileReport: vi.fn(),
}));
vi.mock('@/lib/content-safety/report-service', () => ({ fileReport }));
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
vi.mock('@/lib/auth/request-actor', () => ({ actorFromAuth: (auth: { userId: string }) => ({ userId: auth.userId, kind: 'credential' }) }));

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
    fileReport.mockResolvedValue({ ok: true, caseId: 'case_1', created: true, reportCount: 1, csamGuidance: null });
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

  it('given a report about another user, should also open a content case for review', async () => {
    await call({ targetUserId: 'user_abuser', reason: 'Harassing messages' });
    expect(fileReport).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ userId: ME }), {
      reporter: { kind: 'user', userId: ME },
      target: { type: 'user', userId: 'user_abuser' },
      category: 'harassment',
      description: 'Harassing messages',
    });
  });

  it('given the content case cannot be filed, should still store the user report', async () => {
    fileReport.mockRejectedValue(new Error('db down'));
    const res = await call({ targetUserId: 'user_abuser', reason: 'spam' });
    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalled();
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

  describe('content targets', () => {
    it('given a page report, should file it with the reporter as a signed-in user and answer 201', async () => {
      const res = await call({ target: { type: 'page', pageId: 'page_1' }, category: 'malware', description: 'drive-by download' });
      expect(res.status).toBe(201);
      expect(fileReport).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ userId: ME }), {
        reporter: { kind: 'user', userId: ME },
        target: { type: 'page', pageId: 'page_1' },
        category: 'malware',
        description: 'drive-by download',
      });
      // A content report is not written to the feedback inbox or emailed with its text.
      expect(values).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body).not.toHaveProperty('caseId');
    });

    it('given a page the reporter cannot see, should refuse neutrally', async () => {
      fileReport.mockResolvedValue({ ok: false, reason: 'not_found' });
      const res = await call({ target: { type: 'page', pageId: 'page_secret' }, category: 'other' });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("We couldn't find that content, or you don't have access to it.");
    });

    it('given a CSAM report, should return the CyberTipline guidance', async () => {
      fileReport.mockResolvedValue({
        ok: true, caseId: 'c', created: true, reportCount: 1,
        csamGuidance: { cyberTiplineUrl: 'https://report.cybertip.org/', message: 'm' },
      });
      const res = await call({ target: { type: 'file', fileId: 'a'.repeat(64) }, category: 'csam' });
      expect(res.status).toBe(201);
      expect((await res.json()).csamGuidance.cyberTiplineUrl).toBe('https://report.cybertip.org/');
    });

    it('given an unknown category, should refuse before filing', async () => {
      const res = await call({ target: { type: 'page', pageId: 'p' }, category: 'spam' });
      expect(res.status).toBe(400);
      expect(fileReport).not.toHaveBeenCalled();
    });

    it('given too many reports, should refuse with 429 before filing', async () => {
      checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 60 });
      const res = await call({ target: { type: 'page', pageId: 'p' }, category: 'other' });
      expect(res.status).toBe(429);
      expect(fileReport).not.toHaveBeenCalled();
    });
  });
});
