import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/server', () => ({
  securityAudit: {
    logEvent: vi.fn(),
  },
  loggers: {
    api: {
      warn: vi.fn(),
    },
  },
}));

import { securityAudit, loggers } from '@pagespace/lib/server';
import { logAuditEvent, extractAuditMeta } from '../route-audit';

function fakeRequest(headers: Record<string, string> = {}): Request {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as Request;
}

describe('extractAuditMeta', () => {
  it('extracts ipAddress from x-forwarded-for (first entry)', () => {
    const req = fakeRequest({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' });
    const meta = extractAuditMeta(req);
    expect(meta.ipAddress).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = fakeRequest({ 'x-real-ip': '5.6.7.8' });
    const meta = extractAuditMeta(req);
    expect(meta.ipAddress).toBe('5.6.7.8');
  });

  it('returns unknown when no IP headers present', () => {
    const req = fakeRequest();
    const meta = extractAuditMeta(req);
    expect(meta.ipAddress).toBe('unknown');
  });

  it('extracts userAgent from user-agent header', () => {
    const req = fakeRequest({ 'user-agent': 'Mozilla/5.0' });
    const meta = extractAuditMeta(req);
    expect(meta.userAgent).toBe('Mozilla/5.0');
  });

  it('returns unknown when no user-agent header', () => {
    const req = fakeRequest();
    const meta = extractAuditMeta(req);
    expect(meta.userAgent).toBe('unknown');
  });
});

describe('logAuditEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(securityAudit.logEvent).mockResolvedValue(undefined);
  });

  it('calls securityAudit.logEvent with top-level PII fields (not in details)', () => {
    const req = fakeRequest({ 'x-forwarded-for': '1.2.3.4', 'user-agent': 'TestAgent' });
    logAuditEvent(req, 'user-1', 'read', 'ai_chat', 'res-1', { action: 'test' });

    expect(securityAudit.logEvent).toHaveBeenCalledWith({
      eventType: 'data.read',
      userId: 'user-1',
      resourceType: 'ai_chat',
      resourceId: 'res-1',
      ipAddress: '1.2.3.4',
      userAgent: 'TestAgent',
      details: { action: 'test' },
    });
  });

  it('keeps ipAddress and userAgent out of the details object', () => {
    const req = fakeRequest({ 'x-forwarded-for': '1.2.3.4', 'user-agent': 'TestAgent' });
    logAuditEvent(req, 'user-1', 'write', 'ai_chat', 'res-1', { action: 'test' });

    const callArg = vi.mocked(securityAudit.logEvent).mock.calls[0][0];
    expect(callArg.details).not.toHaveProperty('ipAddress');
    expect(callArg.details).not.toHaveProperty('userAgent');
  });

  it('maps operation to correct event type', () => {
    const req = fakeRequest();
    const ops = ['read', 'write', 'delete', 'export', 'share'] as const;
    const expected = ['data.read', 'data.write', 'data.delete', 'data.export', 'data.share'];

    ops.forEach((op, i) => {
      vi.clearAllMocks();
      vi.mocked(securityAudit.logEvent).mockResolvedValue(undefined);
      logAuditEvent(req, 'u', op, 'r', 'id');
      expect(vi.mocked(securityAudit.logEvent).mock.calls[0][0].eventType).toBe(expected[i]);
    });
  });

  it('logs a warning when securityAudit rejects', async () => {
    const error = new Error('DB connection lost');
    vi.mocked(securityAudit.logEvent).mockRejectedValueOnce(error);

    const req = fakeRequest();
    logAuditEvent(req, 'user-1', 'write', 'ai_chat', 'res-1', { action: 'test' });

    await vi.waitFor(() => {
      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Security audit log failed',
        expect.objectContaining({
          error: 'DB connection lost',
          resourceType: 'ai_chat',
        })
      );
    });
  });

  it('does not throw when securityAudit rejects', async () => {
    vi.mocked(securityAudit.logEvent).mockRejectedValueOnce(new Error('fail'));

    const req = fakeRequest();
    expect(() => {
      logAuditEvent(req, 'user-1', 'read', 'ai_chat', 'res-1', { action: 'test' });
    }).not.toThrow();

    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
