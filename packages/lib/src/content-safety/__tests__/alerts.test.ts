import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock('../../services/email-service', () => ({ sendEmail }));

import { renderEmailToHtml } from '../../email-templates/render-email';
import { contentCaseAdminUrl, resolveAbuseEmail, sendContentSafetyAlert } from '../alerts';

describe('resolveAbuseEmail', () => {
  it('prefers ABUSE_EMAIL, then CONTACT_EMAIL, then the public contact address', () => {
    expect(resolveAbuseEmail({ ABUSE_EMAIL: 'abuse@x.test', CONTACT_EMAIL: 'c@x.test' })).toBe('abuse@x.test');
    expect(resolveAbuseEmail({ ABUSE_EMAIL: '  ', CONTACT_EMAIL: 'c@x.test' })).toBe('c@x.test');
    expect(resolveAbuseEmail({})).toBe('hello@pagespace.ai');
  });
});

describe('contentCaseAdminUrl', () => {
  it('links to the case in the admin console when an admin URL is configured', () => {
    expect(contentCaseAdminUrl('case 1', { ADMIN_APP_URL: 'https://admin.x.test/' })).toBe('https://admin.x.test/content?case=case%201');
    expect(contentCaseAdminUrl('c1', { NEXT_PUBLIC_ADMIN_APP_URL: 'https://admin.y.test' })).toBe('https://admin.y.test/content?case=c1');
    expect(contentCaseAdminUrl('c1', {})).toBeUndefined();
  });

  it('drops every trailing slash, in time linear in the input', () => {
    expect(contentCaseAdminUrl('c1', { ADMIN_APP_URL: 'https://admin.x.test///' })).toBe('https://admin.x.test/content?case=c1');
    expect(contentCaseAdminUrl('c1', { ADMIN_APP_URL: '///' })).toBeUndefined();
    const started = Date.now();
    contentCaseAdminUrl('c1', { ADMIN_APP_URL: `https://a${'/'.repeat(200_000)}x` });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('sendContentSafetyAlert', () => {
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(undefined);
    vi.stubEnv('ABUSE_EMAIL', 'abuse@x.test');
    vi.stubEnv('ADMIN_APP_URL', 'https://admin.x.test');
  });

  it.each(['opened', 'actioned', 'awaiting_evidence', 'resweep_failed'] as const)(
    'emails the abuse inbox for a case that is %s, with the case ID, category and admin link',
    async (event) => {
      await sendContentSafetyAlert({ event, caseId: 'case-123', category: 'csam' });

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const options = sendEmail.mock.calls[0][0];
      expect(options.to).toBe('abuse@x.test');
      expect(options.subject).toContain('case-123');
      expect(options.skipRateLimit).toBe(true);
      expect(options.idempotencyKey).toBe(`content-case:case-123:${event}`);

      const html = await renderEmailToHtml(options.react);
      expect(html).toContain('case-123');
      expect(html).toContain('csam');
      expect(html).toContain('https://admin.x.test/content?case=case-123');
    },
  );

  it('carries no file URL, storage key or hash: the only link is the admin console', async () => {
    await sendContentSafetyAlert({ event: 'actioned', caseId: 'case-123', category: 'malware' });
    const html = await renderEmailToHtml(sendEmail.mock.calls[0][0].react);

    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual(['https://admin.x.test/content?case=case-123']);
    expect(html).not.toMatch(/[0-9a-f]{64}/);
    expect(html).not.toMatch(/files\/|assets\/|chat-attachments\/|cache\//);
  });

  it('keeps each failed re-sweep attempt\'s alert distinct, so a retry is not collapsed into the first', async () => {
    await sendContentSafetyAlert({ event: 'resweep_failed', caseId: 'case-123', category: 'csam', attempt: 2 });
    expect(sendEmail.mock.calls[0][0].idempotencyKey).toBe('content-case:case-123:resweep_failed:2');
  });

  it('surfaces a send failure to the caller', async () => {
    sendEmail.mockRejectedValue(new Error('resend down'));
    await expect(sendContentSafetyAlert({ event: 'opened', caseId: 'c', category: null })).rejects.toThrow('resend down');
  });

  it.each(['report_opened', 'report_added'] as const)('emails a %s alert with the case ID, category, report count and admin link', async (event) => {
    await sendContentSafetyAlert({ event, caseId: 'case-9', category: 'copyright', reportCount: 3 });

    const options = sendEmail.mock.calls[0][0];
    expect(options.to).toBe('abuse@x.test');
    expect(options.subject).toContain('case-9');
    expect(options.subject).not.toMatch(/URGENT/);
    expect(options.headers).toBeUndefined();
    expect(options.idempotencyKey).toBe('content-case:case-9:report:3');

    const html = await renderEmailToHtml(options.react);
    expect(html).toContain('case-9');
    expect(html).toContain('copyright');
    // React may put tags or `<!-- -->` between the label and the number; `<[^>]*>` covers both, and the two
    // alternatives never match the same text, so the pattern cannot backtrack.
    expect(html).toMatch(/Reports:(?:\s|<[^>]*>)*3\b/);
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual(['https://admin.x.test/content?case=case-9']);
  });

  it('marks a CSAM report urgent in the subject and as high priority', async () => {
    await sendContentSafetyAlert({ event: 'report_opened', caseId: 'case-c', category: 'csam', reportCount: 1 });
    const options = sendEmail.mock.calls[0][0];
    expect(options.subject).toMatch(/^\[URGENT\]/);
    expect(options.subject).toMatch(/CSAM/);
    expect(options.headers).toEqual({ 'X-Priority': '1', Importance: 'high', Priority: 'urgent' });
  });
});
