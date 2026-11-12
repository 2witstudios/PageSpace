import { describe, it, expect, vi, beforeEach } from 'vitest';

const { checkDistributedRateLimit, fileReport } = vi.hoisted(() => ({
  checkDistributedRateLimit: vi.fn(),
  fileReport: vi.fn(),
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS: { CONTENT_REPORT: { maxAttempts: 10, windowMs: 3600000 } },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } } }));
vi.mock('@/lib/auth/auth-helpers', () => ({ getClientIP: () => '203.0.113.7' }));
vi.mock('@/lib/content-safety/report-service', () => ({ fileReport }));

import { POST } from '../route';

const URL_OK = 'https://acme.pagespace.site/about';
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://localhost/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

describe('POST /api/report (public)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkDistributedRateLimit.mockResolvedValue({ allowed: true });
    fileReport.mockResolvedValue({ ok: true, caseId: 'case_1', created: true, reportCount: 1, csamGuidance: null });
  });

  it('files an anonymous report of a published URL with the optional contact email, and never the IP', async () => {
    const res = await post({ url: URL_OK, category: 'copyright', description: 'my photo', contactEmail: 'me@example.com' });
    expect(res.status).toBe(201);
    expect(fileReport).toHaveBeenCalledWith(expect.any(Request), null, {
      reporter: { kind: 'anonymous', contactEmail: 'me@example.com' },
      target: { type: 'published_url', url: URL_OK },
      category: 'copyright',
      description: 'my photo',
    });
    expect(JSON.stringify(fileReport.mock.calls[0][2])).not.toContain('203.0.113.7');
    const body = await res.json();
    expect(body).not.toHaveProperty('caseId');
  });

  it('rate-limits by IP, and refuses once the limit is reached', async () => {
    await post({ url: URL_OK, category: 'other' });
    expect(checkDistributedRateLimit).toHaveBeenCalledWith('content-report:ip:203.0.113.7', expect.objectContaining({ maxAttempts: 10 }));

    checkDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 1800 });
    const res = await post({ url: URL_OK, category: 'other' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1800');
    expect(fileReport).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-PageSpace URL with a neutral message', async () => {
    fileReport.mockResolvedValue({ ok: false, reason: 'not_pagespace_url' });
    const res = await post({ url: 'https://evil.example.org/', category: 'other' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sites published on PageSpace/);
  });

  it('answers a filled honeypot exactly like a real report, and files nothing', async () => {
    const res = await post({ url: URL_OK, category: 'other', _hp: 'http://spam.test' });
    expect(res.status).toBe(201);
    expect(fileReport).not.toHaveBeenCalled();
  });

  it('refuses an oversized body before parsing it', async () => {
    const res = await post({ url: URL_OK, category: 'other', description: 'x'.repeat(9000) });
    expect(res.status).toBe(413);
    expect(fileReport).not.toHaveBeenCalled();
  });

  it('refuses malformed JSON and an invalid contact email', async () => {
    expect((await post('{nope')).status).toBe(400);
    expect((await post({ url: URL_OK, category: 'other', contactEmail: 'nope' })).status).toBe(400);
    expect(fileReport).not.toHaveBeenCalled();
  });

  it('returns the CyberTipline guidance for a CSAM report', async () => {
    fileReport.mockResolvedValue({
      ok: true, caseId: 'c', created: true, reportCount: 1,
      csamGuidance: { cyberTiplineUrl: 'https://report.cybertip.org/', message: 'm' },
    });
    const res = await post({ url: URL_OK, category: 'csam' });
    expect((await res.json()).csamGuidance.cyberTiplineUrl).toBe('https://report.cybertip.org/');
  });

  it('answers 500 without detail when filing fails', async () => {
    fileReport.mockRejectedValue(new Error('db down'));
    const res = await post({ url: URL_OK, category: 'other' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('db down');
  });
});
