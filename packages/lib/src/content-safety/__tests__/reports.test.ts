import { describe, it, expect } from 'vitest';
import {
  CSAM_REPORT_GUIDANCE,
  caseCategoryAfterReport,
  classifyReportUrl,
  publicReportSchema,
  signedInReportSchema,
} from '../reports';

const HOST = 'pagespace.site';

describe('classifyReportUrl', () => {
  it('accepts a page on a published subdomain', () => {
    const result = classifyReportUrl('https://acme.pagespace.site/about', HOST);
    expect(result).toEqual({ kind: 'publish_subdomain', host: 'acme.pagespace.site', url: 'https://acme.pagespace.site/about' });
  });

  it('accepts a published asset path and ignores case and port in the host', () => {
    expect(classifyReportUrl('http://ACME.pagespace.site:443/assets/abc', HOST)?.kind).toBe('publish_subdomain');
  });

  it('treats any other public hostname as a custom-domain candidate, to be confirmed against our domains', () => {
    expect(classifyReportUrl('https://blog.example.com/post', HOST)).toEqual({
      kind: 'custom_domain_candidate',
      host: 'blog.example.com',
      url: 'https://blog.example.com/post',
    });
  });

  it.each([
    ['not a URL', 'acme.pagespace.site/about'],
    ['another scheme', 'ftp://acme.pagespace.site/x'],
    ['javascript', 'javascript:alert(1)'],
    ['the bare publish host', 'https://pagespace.site/'],
    ['a nested subdomain', 'https://a.b.pagespace.site/'],
    ['credentials in the URL', 'https://user:pw@acme.pagespace.site/'],
    ['an IPv4 literal', 'https://10.0.0.1/'],
    ['an IPv6 literal', 'https://[::1]/'],
    ['a single-label host', 'https://localhost/'],
    ['an app path, not published content', 'https://acme.pagespace.site/dashboard/d1/p1'],
    ['an API path', 'https://acme.pagespace.site/api/avatar/u1/a.png'],
    ['an over-long URL', `https://acme.pagespace.site/${'a'.repeat(2100)}`],
  ])('rejects %s', (_label, input) => {
    expect(classifyReportUrl(input, HOST)).toBeNull();
  });
});

describe('signedInReportSchema', () => {
  it('accepts each target type with a category and free text', () => {
    for (const target of [
      { type: 'page', pageId: 'page_1' },
      { type: 'file', fileId: 'a'.repeat(64) },
      { type: 'user', userId: 'user_1' },
      { type: 'published_url', url: 'https://acme.pagespace.site/x' },
    ]) {
      const parsed = signedInReportSchema.safeParse({ target, category: 'harassment', description: '  hello  ' });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.description).toBe('hello');
    }
  });

  it('refuses an unknown category, a malformed ID and text over the limit', () => {
    expect(signedInReportSchema.safeParse({ target: { type: 'page', pageId: 'p1' }, category: 'spam' }).success).toBe(false);
    expect(signedInReportSchema.safeParse({ target: { type: 'page', pageId: '../x' }, category: 'other' }).success).toBe(false);
    expect(
      signedInReportSchema.safeParse({ target: { type: 'page', pageId: 'p1' }, category: 'other', description: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('does not require free text: a CSAM reporter should not have to describe the material', () => {
    expect(signedInReportSchema.safeParse({ target: { type: 'page', pageId: 'p1' }, category: 'csam' }).success).toBe(true);
  });
});

describe('publicReportSchema', () => {
  it('accepts a URL, category, description and an optional contact email', () => {
    const parsed = publicReportSchema.safeParse({
      url: 'https://acme.pagespace.site/x',
      category: 'copyright',
      description: 'my photo',
      contactEmail: ' me@example.com ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.contactEmail).toBe('me@example.com');
  });

  it('treats an empty contact email as none, and refuses a malformed one', () => {
    const empty = publicReportSchema.safeParse({ url: 'https://a.pagespace.site/', category: 'other', contactEmail: '' });
    expect(empty.success && empty.data.contactEmail).toBeUndefined();
    expect(publicReportSchema.safeParse({ url: 'https://a.pagespace.site/', category: 'other', contactEmail: 'nope' }).success).toBe(false);
  });
});

describe('caseCategoryAfterReport', () => {
  it('takes the category of a report about illegal content', () => {
    expect(caseCategoryAfterReport(null, 'malware')).toBe('malware');
    expect(caseCategoryAfterReport(null, 'illegal_other')).toBe('illegal_other');
    expect(caseCategoryAfterReport(null, 'csam')).toBe('csam');
  });

  it('leaves the case uncategorised for reports that are not a block category', () => {
    expect(caseCategoryAfterReport(null, 'copyright')).toBeNull();
    expect(caseCategoryAfterReport(null, 'harassment')).toBeNull();
    expect(caseCategoryAfterReport(null, 'other')).toBeNull();
  });

  it('keeps the first category, except that CSAM always wins and is never downgraded', () => {
    expect(caseCategoryAfterReport('malware', 'illegal_other')).toBe('malware');
    expect(caseCategoryAfterReport('malware', 'csam')).toBe('csam');
    expect(caseCategoryAfterReport('csam', 'malware')).toBe('csam');
    expect(caseCategoryAfterReport('csam', 'other')).toBe('csam');
  });
});

describe('CSAM_REPORT_GUIDANCE', () => {
  it('points to the NCMEC CyberTipline and tells the reporter not to keep or share the material', () => {
    expect(CSAM_REPORT_GUIDANCE.cyberTiplineUrl).toBe('https://report.cybertip.org/');
    expect(CSAM_REPORT_GUIDANCE.message).toMatch(/download/i);
    expect(CSAM_REPORT_GUIDANCE.message).toMatch(/screenshot/i);
    expect(CSAM_REPORT_GUIDANCE.message).toMatch(/forward/i);
  });
});
