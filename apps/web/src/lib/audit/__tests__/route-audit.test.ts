import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/server', () => ({
  securityAudit: {
    logDataAccess: vi.fn(),
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
    vi.mocked(securityAudit.logDataAccess).mockResolvedValue(undefined);
  });

  it('calls securityAudit.logDataAccess with the provided args', () => {
    const req = fakeRequest({ 'x-forwarded-for': '1.2.3.4', 'user-agent': 'TestAgent' });
    logAuditEvent(req, 'user-1', 'read', 'ai_chat', 'res-1', { action: 'test' });

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      'user-1',
      'read',
      'ai_chat',
      'res-1',
      {
        action: 'test',
        ipAddress: '1.2.3.4',
        userAgent: 'TestAgent',
      }
    );
  });

  it('logs a warning when securityAudit rejects', async () => {
    const error = new Error('DB connection lost');
    vi.mocked(securityAudit.logDataAccess).mockRejectedValueOnce(error);

    const req = fakeRequest();
    logAuditEvent(req, 'user-1', 'write', 'ai_chat', 'res-1', { action: 'test' });

    // Let the microtask queue flush so the .catch handler runs
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
    vi.mocked(securityAudit.logDataAccess).mockRejectedValueOnce(new Error('fail'));

    const req = fakeRequest();
    // Should not throw
    expect(() => {
      logAuditEvent(req, 'user-1', 'read', 'ai_chat', 'res-1', { action: 'test' });
    }).not.toThrow();

    // Flush microtasks
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
