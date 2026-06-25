import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks — shared state accessible from vi.mock factories
const { mockLoggers, mockSecurityAudit } = vi.hoisted(() => ({
  mockLoggers: {
    security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
  mockSecurityAudit: {
    logEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: mockLoggers,
}));

vi.mock('../security-audit', () => ({
  securityAudit: mockSecurityAudit,
}));

vi.mock('@pagespace/db/db', () => ({
  db: {},
}));
vi.mock('@pagespace/db/schema/security-audit', () => ({
  securityAuditLog: {},
}));

import { audit, auditRequest } from '../audit-log';

describe('audit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecurityAudit.logEvent.mockResolvedValue(undefined);
  });

  it('given an AuditEvent, should write to structured logger', () => {
    audit({
      eventType: 'auth.login.success',
      userId: 'user-1',
    });

    expect(mockLoggers.security.info).toHaveBeenCalledWith(
      expect.stringContaining('auth.login.success'),
      expect.objectContaining({ eventType: 'auth.login.success', userId: 'user-1' })
    );
  });

  it('given an AuditEvent, should write to tamper-evident audit DB', () => {
    audit({
      eventType: 'auth.login.success',
      userId: 'user-1',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'auth.login.success',
        userId: 'user-1',
      })
    );
  });

  it('given riskScore >= 0.5, should log at warn level', () => {
    audit({
      eventType: 'authz.access.denied',
      userId: 'user-1',
      riskScore: 0.5,
    });

    expect(mockLoggers.security.warn).toHaveBeenCalled();
    expect(mockLoggers.security.info).not.toHaveBeenCalled();
  });

  it('given riskScore < 0.5, should log at info level', () => {
    audit({
      eventType: 'auth.login.success',
      userId: 'user-1',
      riskScore: 0.3,
    });

    expect(mockLoggers.security.info).toHaveBeenCalled();
    expect(mockLoggers.security.warn).not.toHaveBeenCalled();
  });

  it('given no riskScore, should log at info level', () => {
    audit({
      eventType: 'data.read',
      userId: 'user-1',
    });

    expect(mockLoggers.security.info).toHaveBeenCalled();
    expect(mockLoggers.security.warn).not.toHaveBeenCalled();
  });

  it('given the DB throws, should catch and log warning without throwing', async () => {
    mockSecurityAudit.logEvent.mockRejectedValueOnce(new Error('DB down'));

    // Should not throw
    audit({
      eventType: 'auth.login.success',
      userId: 'user-1',
    });

    await vi.waitFor(() => {
      expect(mockLoggers.security.warn).toHaveBeenCalledWith(
        expect.stringContaining('audit write failed'),
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  it('given an event with all fields, should pass them through to the DB', () => {
    audit({
      eventType: 'data.write',
      userId: 'user-1',
      sessionId: 'sess-1',
      serviceId: 'web',
      resourceType: 'page',
      resourceId: 'page-1',
      ipAddress: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      details: { action: 'update' },
      riskScore: 0.1,
      anomalyFlags: ['new_device'],
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.write',
        userId: 'user-1',
        sessionId: 'sess-1',
        serviceId: 'web',
        resourceType: 'page',
        resourceId: 'page-1',
        ipAddress: '1.2.3.4',
        userAgent: 'Mozilla/5.0',
        details: { action: 'update' },
        riskScore: 0.1,
        anomalyFlags: ['new_device'],
      })
    );
  });
});

describe('auditRequest()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecurityAudit.logEvent.mockResolvedValue(undefined);
  });

  it('given a Request, should extract ipAddress from x-forwarded-for header', () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        'x-forwarded-for': '10.0.0.1, 10.0.0.2',
        'user-agent': 'TestAgent/1.0',
      },
    });

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
      resourceType: 'page',
      resourceId: 'page-1',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: '10.0.0.1',
      })
    );
  });

  it('given no x-forwarded-for, should fall back to x-real-ip', () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        'x-real-ip': '192.168.1.1',
        'user-agent': 'TestAgent/1.0',
      },
    });

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: '192.168.1.1',
      })
    );
  });

  it('given no IP headers, should use "unknown"', () => {
    const req = new Request('http://localhost/api/test', {
      headers: { 'user-agent': 'TestAgent/1.0' },
    });

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: 'unknown',
      })
    );
  });

  it('given a Request, should extract userAgent from headers', () => {
    const req = new Request('http://localhost/api/test', {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome' },
    });

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: 'Mozilla/5.0 Chrome',
      })
    );
  });

  it('given no user-agent header, should use "unknown"', () => {
    const req = new Request('http://localhost/api/test');

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: 'unknown',
      })
    );
  });

  it('given event already has ipAddress, should not override with header value', () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        'x-forwarded-for': '10.0.0.1',
        'user-agent': 'TestAgent/1.0',
      },
    });

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
      ipAddress: '99.99.99.99',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: '99.99.99.99',
      })
    );
  });

  it('given event already has userAgent, should not override with header value', () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        'x-forwarded-for': '10.0.0.1',
        'user-agent': 'FromHeader/1.0',
      },
    });

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
      userAgent: 'ExplicitAgent/2.0',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: 'ExplicitAgent/2.0',
      })
    );
  });

  it('given empty x-forwarded-for header, should fall back to x-real-ip', () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        'x-forwarded-for': '',
        'x-real-ip': '192.168.1.1',
        'user-agent': 'TestAgent/1.0',
      },
    });

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: '192.168.1.1',
      })
    );
  });

  it('given whitespace-only x-forwarded-for, should fall back to x-real-ip', () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        'x-forwarded-for': '  ',
        'x-real-ip': '172.16.0.1',
        'user-agent': 'TestAgent/1.0',
      },
    });

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: '172.16.0.1',
      })
    );
  });

  it('given empty user-agent header, should use "unknown"', () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        'user-agent': '',
      },
    });

    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
    });

    expect(mockSecurityAudit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: 'unknown',
      })
    );
  });

  it('given a Request and event, should delegate to audit() for dual-write', () => {
    const req = new Request('http://localhost/api/test', {
      headers: { 'user-agent': 'TestAgent/1.0' },
    });

    auditRequest(req, {
      eventType: 'security.rate.limited',
      riskScore: 0.5,
    });

    // Should log at warn level (riskScore >= 0.5) AND write to DB
    expect(mockLoggers.security.warn).toHaveBeenCalled();
    expect(mockSecurityAudit.logEvent).toHaveBeenCalled();
  });
});

/**
 * GDPR (#971): runtime enforcement that user-typed search text / PII never
 * reaches the tamper-evident hash chain. Proves the wired sanitizer at the
 * audit edge — if a search route audit call were ever given `query` text, the
 * details that get persisted (logEvent) would NOT contain it.
 */
describe('audit pipeline GDPR sanitization (#971)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecurityAudit.logEvent.mockResolvedValue(undefined);
  });

  it('strips user-typed query text from details before persistence (audit)', () => {
    audit({
      eventType: 'data.read',
      userId: 'user-1',
      resourceType: 'search',
      resourceId: '*',
      details: { query: 'sensitive personal search', resultCount: 4 },
    });

    const persisted = mockSecurityAudit.logEvent.mock.calls[0]?.[0];
    expect(persisted.details.query).not.toBe('sensitive personal search');
    expect(persisted.details.query).toBe('[redacted]');
    expect(persisted.details.resultCount).toBe(4);

    // And nothing logged to the structured logger leaks it either.
    const loggedPayload = JSON.stringify(mockLoggers.security.info.mock.calls);
    expect(loggedPayload).not.toContain('sensitive personal search');
  });

  it('strips query text from a search-route-shaped auditRequest call', () => {
    const req = new Request('http://localhost/api/search?q=top+secret', {
      headers: { 'user-agent': 'TestAgent/1.0' },
    });

    // Simulate a (hypothetical) regression where a route puts query in details.
    auditRequest(req, {
      eventType: 'data.read',
      userId: 'user-1',
      resourceType: 'search',
      resourceId: '*',
      details: { searchQuery: 'top secret', source: 'multi-drive', resultCount: 2 },
    });

    const persisted = mockSecurityAudit.logEvent.mock.calls[0]?.[0];
    expect(persisted.details.searchQuery).toBe('[redacted]');
    expect(persisted.details.source).toBe('multi-drive');
    expect(persisted.details.resultCount).toBe(2);
  });

  it('leaves clean search details (counts/source) untouched', () => {
    audit({
      eventType: 'data.read',
      userId: 'user-1',
      resourceType: 'search',
      resourceId: '*',
      details: { resultCount: 9, source: 'mentions' },
    });

    const persisted = mockSecurityAudit.logEvent.mock.calls[0]?.[0];
    expect(persisted.details).toEqual({ resultCount: 9, source: 'mentions' });
  });
});
