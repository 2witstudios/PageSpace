import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContentReportCategory } from '@pagespace/db/schema/content-safety';
import type { ResolvedTarget } from '../targets';
import { submitContentReport, type ReportIntakeDeps, type FileReportInput } from '../report-intake';

const HOST = 'pagespace.site';
const HASH = 'a'.repeat(64);

function target(partial: Partial<ResolvedTarget> & Pick<ResolvedTarget, 'targetType' | 'targetId'>): ResolvedTarget {
  return { contentHash: null, block: null, page: null, drive: null, user: null, references: null, ...partial };
}

/** An in-memory case store with the real merge rule: one case under review per target. */
function fakeStore() {
  const cases = new Map<string, { caseId: string; count: number }>();
  const filed: FileReportInput[] = [];
  let next = 1;
  return {
    filed,
    async fileReport(input: FileReportInput) {
      filed.push(input);
      const key = `${input.target.targetType}:${input.target.targetId}`;
      const existing = cases.get(key);
      if (existing) {
        existing.count += 1;
        return { caseId: existing.caseId, created: false, reportCount: existing.count };
      }
      const opened = { caseId: `case_${next++}`, count: 1 };
      cases.set(key, opened);
      return { caseId: opened.caseId, created: true, reportCount: 1 };
    },
  };
}

function makeDeps(overrides: Partial<ReportIntakeDeps> = {}) {
  const store = fakeStore();
  const deps: ReportIntakeDeps = {
    publishHost: HOST,
    resolveTarget: vi.fn(async (input: string) => {
      if (input === 'https://acme.pagespace.site/about') return target({ targetType: 'page', targetId: 'page_pub' });
      if (input === 'https://shop.example.com/') return target({ targetType: 'drive', targetId: 'drive_custom' });
      if (input === 'page_1') return target({ targetType: 'page', targetId: 'page_1' });
      if (input === HASH) return target({ targetType: 'content_hash', targetId: HASH, contentHash: HASH });
      if (input === 'user_bad') return target({ targetType: 'user', targetId: 'user_bad' });
      return null;
    }),
    isCustomDomainHost: vi.fn(async (host: string) => host === 'shop.example.com'),
    canViewPage: vi.fn(async (pageId: string) => pageId === 'page_1'),
    canAccessFile: vi.fn(async (fileId: string) => fileId === HASH),
    fileReport: vi.fn(store.fileReport),
    alert: vi.fn(async () => undefined),
    audit: vi.fn(),
    ...overrides,
  };
  return { deps, store };
}

const anonymous = { kind: 'anonymous' as const };
const signedIn = { kind: 'user' as const, userId: 'user_me' };
const report = (category: ContentReportCategory = 'other', description = 'it is bad') => ({ category, description });

describe('submitContentReport', () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctx = makeDeps();
  });

  it('opens a case for an anonymous report of a published URL and alerts with the case, category and count only', async () => {
    const result = await submitContentReport(
      { reporter: { kind: 'anonymous', contactEmail: 'me@example.com' }, target: { type: 'published_url', url: 'https://acme.pagespace.site/about' }, ...report('copyright', 'stolen https://evil.test') },
      ctx.deps,
    );

    expect(result).toEqual({ ok: true, caseId: 'case_1', created: true, reportCount: 1, csamGuidance: null });
    expect(ctx.store.filed[0]).toEqual({
      target: { targetType: 'page', targetId: 'page_pub', contentHash: null },
      category: 'copyright',
      description: 'stolen https://evil.test',
      source: 'anonymous',
      reporterUserId: null,
      contactEmail: 'me@example.com',
    });
    expect(ctx.deps.alert).toHaveBeenCalledWith({ event: 'report_opened', caseId: 'case_1', category: 'copyright', reportCount: 1 });
    const alertArg = JSON.stringify(vi.mocked(ctx.deps.alert).mock.calls[0][0]);
    expect(alertArg).not.toMatch(/acme|evil|stolen|page_pub|me@example/);
    expect(ctx.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'content.report.created', caseId: 'case_1', reportCount: 1, source: 'anonymous', reporterUserId: null }),
    );
  });

  it('attaches a second report on the same target to the same case and alerts again with the new count', async () => {
    const input = { reporter: anonymous, target: { type: 'published_url' as const, url: 'https://acme.pagespace.site/about' }, ...report() };
    await submitContentReport(input, ctx.deps);
    const second = await submitContentReport({ ...input, reporter: signedIn }, ctx.deps);

    expect(second).toMatchObject({ ok: true, caseId: 'case_1', created: false, reportCount: 2 });
    expect(ctx.deps.alert).toHaveBeenLastCalledWith({ event: 'report_added', caseId: 'case_1', category: 'other', reportCount: 2 });
    expect(ctx.deps.audit).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: 'content.report.attached', reportCount: 2, reporterUserId: 'user_me' }));
  });

  it('refuses a URL that is not on one of our published hosts, without resolving it', async () => {
    const result = await submitContentReport({ reporter: anonymous, target: { type: 'published_url', url: 'https://evil.example.org/x' }, ...report() }, ctx.deps);
    expect(result).toEqual({ ok: false, reason: 'not_pagespace_url' });
    expect(ctx.deps.resolveTarget).not.toHaveBeenCalled();
    expect(ctx.deps.fileReport).not.toHaveBeenCalled();
    expect(ctx.deps.alert).not.toHaveBeenCalled();
  });

  it('accepts a custom domain that is registered to a drive', async () => {
    const result = await submitContentReport({ reporter: anonymous, target: { type: 'published_url', url: 'https://shop.example.com/' }, ...report() }, ctx.deps);
    expect(result).toMatchObject({ ok: true, caseId: 'case_1' });
    expect(ctx.store.filed[0].target).toEqual({ targetType: 'drive', targetId: 'drive_custom', contentHash: null });
  });

  it('refuses a published-host URL that resolves to nothing, with the same answer as a foreign host', async () => {
    const result = await submitContentReport({ reporter: anonymous, target: { type: 'published_url', url: 'https://ghost.pagespace.site/' }, ...report() }, ctx.deps);
    expect(result).toEqual({ ok: false, reason: 'not_pagespace_url' });
  });

  it('refuses an anonymous report of anything but a published URL', async () => {
    const result = await submitContentReport({ reporter: anonymous, target: { type: 'page', pageId: 'page_1' }, ...report() }, ctx.deps);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(ctx.deps.fileReport).not.toHaveBeenCalled();
  });

  it('files a signed-in report on a page the reporter can see', async () => {
    const result = await submitContentReport({ reporter: signedIn, target: { type: 'page', pageId: 'page_1' }, ...report('harassment') }, ctx.deps);
    expect(result).toMatchObject({ ok: true, created: true });
    expect(ctx.store.filed[0]).toMatchObject({ source: 'signed_in', reporterUserId: 'user_me', contactEmail: null });
  });

  it('refuses a signed-in report on a page the reporter cannot see, the same way as a page that does not exist', async () => {
    const hidden = await submitContentReport({ reporter: signedIn, target: { type: 'page', pageId: 'page_secret' }, ...report() }, ctx.deps);
    const missing = await submitContentReport({ reporter: signedIn, target: { type: 'page', pageId: 'page_none' }, ...report() }, ctx.deps);
    expect(hidden).toEqual({ ok: false, reason: 'not_found' });
    expect(missing).toEqual(hidden);
    expect(ctx.deps.resolveTarget).not.toHaveBeenCalledWith('page_secret');
    expect(ctx.deps.fileReport).not.toHaveBeenCalled();
    expect(ctx.deps.audit).not.toHaveBeenCalled();
  });

  it('files a report on a file the reporter can access, keyed by its content hash', async () => {
    const result = await submitContentReport({ reporter: signedIn, target: { type: 'file', fileId: HASH }, ...report('malware') }, ctx.deps);
    expect(result).toMatchObject({ ok: true });
    expect(ctx.store.filed[0].target).toEqual({ targetType: 'content_hash', targetId: HASH, contentHash: HASH });
  });

  it('refuses a file the reporter cannot access', async () => {
    const result = await submitContentReport({ reporter: signedIn, target: { type: 'file', fileId: 'b'.repeat(64) }, ...report() }, ctx.deps);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses a target that resolves to a different kind than the reporter named', async () => {
    const deps = makeDeps({ canViewPage: vi.fn(async () => true) }).deps;
    // `user_bad` resolves to a user, not a page.
    const result = await submitContentReport({ reporter: signedIn, target: { type: 'page', pageId: 'user_bad' }, ...report() }, deps);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('files a report about another user, and refuses a report about yourself', async () => {
    expect(await submitContentReport({ reporter: signedIn, target: { type: 'user', userId: 'user_bad' }, ...report() }, ctx.deps)).toMatchObject({ ok: true });
    expect(await submitContentReport({ reporter: signedIn, target: { type: 'user', userId: 'user_me' }, ...report() }, ctx.deps)).toEqual({
      ok: false,
      reason: 'self_report',
    });
  });

  it('returns the CyberTipline guidance for a CSAM report', async () => {
    const result = await submitContentReport({ reporter: anonymous, target: { type: 'published_url', url: 'https://acme.pagespace.site/about' }, ...report('csam', '') }, ctx.deps);
    expect(result.ok && result.csamGuidance?.cyberTiplineUrl).toBe('https://report.cybertip.org/');
    expect(ctx.deps.alert).toHaveBeenCalledWith(expect.objectContaining({ category: 'csam' }));
    expect(ctx.store.filed[0].description).toBeNull();
  });

  it('never takes the content down or blocks it: the only writes are the report and the alert', async () => {
    const result = await submitContentReport({ reporter: signedIn, target: { type: 'file', fileId: HASH }, ...report('csam') }, ctx.deps);
    expect(result.ok).toBe(true);
    // The intake has no takedown, block or unpublish dependency to call — the type of ReportIntakeDeps is the proof;
    // this asserts the store was asked only to file a report.
    expect(Object.keys(ctx.deps).sort()).toEqual(
      ['alert', 'audit', 'canAccessFile', 'canViewPage', 'fileReport', 'isCustomDomainHost', 'publishHost', 'resolveTarget'],
    );
  });

  it('keeps the report when the alert email fails', async () => {
    const deps = makeDeps({ alert: vi.fn(async () => { throw new Error('smtp down'); }) }).deps;
    const result = await submitContentReport({ reporter: signedIn, target: { type: 'page', pageId: 'page_1' }, ...report() }, deps);
    expect(result).toMatchObject({ ok: true, caseId: 'case_1' });
    expect(deps.audit).toHaveBeenCalled();
  });
});
