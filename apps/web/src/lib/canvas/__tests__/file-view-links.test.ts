import { describe, expect, it } from 'vitest';
import {
  extractDashboardFileViewRefs,
  rewriteDashboardFileViewLinks,
  extractInterPageLinks,
  rewriteInterPageLinks,
} from '../file-view-links';

describe('extractDashboardFileViewRefs', () => {
  it('given relative and absolute dashboard file links, should extract unique drive/page refs', () => {
    const html = [
      '<img src="/dashboard/drive-1/file-1/view">',
      '<a href="https://pagespace.ai/dashboard/drive-1/file-1/view">open</a>',
      '<img src="/dashboard/drive-2/file-2/view?token=old">',
    ].join('');

    expect(extractDashboardFileViewRefs(html)).toEqual([
      { driveId: 'drive-1', pageId: 'file-1' },
      { driveId: 'drive-2', pageId: 'file-2' },
    ]);
  });

  it('given non-view dashboard paths, should ignore them', () => {
    expect(extractDashboardFileViewRefs('<img src="/dashboard/drive-1/file-1/edit">')).toEqual([]);
  });
});

describe('rewriteDashboardFileViewLinks', () => {
  it('given a signed URL for a dashboard ref, should rewrite only that full link occurrence', () => {
    const html = [
      '<img src="/dashboard/drive-1/file-1/view">',
      '<img src="/dashboard/drive-2/file-2/view">',
    ].join('');

    const rewritten = rewriteDashboardFileViewLinks(html, ({ driveId, pageId }) =>
      driveId === 'drive-1' && pageId === 'file-1'
        ? `/dashboard/${driveId}/${pageId}/view?token=signed`
        : null,
    );

    expect(rewritten).toContain('/dashboard/drive-1/file-1/view?token=signed');
    expect(rewritten).toContain('/dashboard/drive-2/file-2/view');
  });
});

describe('extractInterPageLinks', () => {
  it('given plain and /view dashboard page links, should extract unique drive/page refs', () => {
    const html = [
      '<a href="/dashboard/drive-1/page-1">one</a>',
      '<a href="/dashboard/drive-1/page-2/view">two</a>',
      '<a href="https://pagespace.ai/dashboard/drive-1/page-1">dup</a>',
      '<a href="/dashboard/drive-1/page-3?ref=x">three</a>',
    ].join('');

    expect(extractInterPageLinks(html)).toEqual([
      { driveId: 'drive-1', pageId: 'page-1' },
      { driveId: 'drive-1', pageId: 'page-2' },
      { driveId: 'drive-1', pageId: 'page-3' },
    ]);
  });

  it('given a longer dashboard sub-path, should not extract a partial page link', () => {
    expect(extractInterPageLinks('<a href="/dashboard/drive-1/page-1/edit">x</a>')).toEqual([]);
    expect(extractInterPageLinks('<a href="/dashboard/drive-1/page-1/view/child">x</a>')).toEqual([]);
  });

  it('given a single-segment dashboard path, should extract nothing', () => {
    expect(extractInterPageLinks('<a href="/dashboard/inbox">x</a>')).toEqual([]);
  });

  it('given a protocol-relative dashboard link, should extract the page ref', () => {
    expect(extractInterPageLinks('<a href="//app.pagespace.ai/dashboard/drive-1/page-1">x</a>')).toEqual([
      { driveId: 'drive-1', pageId: 'page-1' },
    ]);
  });

  it('given /dashboard/ embedded mid-token (not at a delimiter), should not extract it', () => {
    expect(extractInterPageLinks('<a href="docs/dashboard/drive-1/page-1">x</a>')).toEqual([]);
  });

  it('given no dashboard links, should return an empty array', () => {
    expect(extractInterPageLinks('<p>no links</p>')).toEqual([]);
    expect(extractInterPageLinks('')).toEqual([]);
  });
});

describe('rewriteInterPageLinks', () => {
  const SUB = 'acme';

  it('given a link to a published sibling, should rewrite to its pagespace.site URL', () => {
    const html = '<a href="/dashboard/drive-1/page-1">go</a>';
    const map = new Map([['page-1', 'about/team']]);

    expect(rewriteInterPageLinks(html, map, SUB)).toContain(
      'href="https://acme.pagespace.site/about/team"',
    );
  });

  it('given a link to the home page (empty path), should rewrite to the site root', () => {
    const html = '<a href="/dashboard/drive-1/home-page">home</a>';
    const map = new Map([['home-page', '']]);

    expect(rewriteInterPageLinks(html, map, SUB)).toBe('<a href="/">home</a>');
  });

  it('given the /view form of a published page link, should rewrite it too', () => {
    const html = '<a href="https://pagespace.ai/dashboard/drive-1/page-1/view">go</a>';
    const map = new Map([['page-1', 'docs']]);

    const out = rewriteInterPageLinks(html, map, SUB);
    expect(out).toContain('href="https://acme.pagespace.site/docs"');
    expect(out).not.toContain('/dashboard/');
  });

  it('given a link to an unpublished / out-of-drive page (absent from map), should leave it unchanged', () => {
    const html = '<a href="/dashboard/drive-1/missing">x</a>';

    expect(rewriteInterPageLinks(html, new Map(), SUB)).toBe(html);
  });

  it('given a protocol-relative link, should replace the whole URL (no leftover prefix)', () => {
    const html = '<a href="//app.pagespace.ai/dashboard/drive-1/page-1">go</a>';
    const map = new Map([['page-1', 'about']]);

    const out = rewriteInterPageLinks(html, map, SUB);
    expect(out).toBe('<a href="https://acme.pagespace.site/about">go</a>');
    expect(out).not.toContain('app.pagespace.ai');
  });

  it('given /dashboard/ embedded mid-token, should leave it untouched (no glued URL)', () => {
    const html = '<a href="docs/dashboard/drive-1/page-1">x</a>';
    const map = new Map([['page-1', 'about']]);

    expect(rewriteInterPageLinks(html, map, SUB)).toBe(html);
  });

  it('given a mix of published and unpublished links, should rewrite only the published ones', () => {
    const html = [
      '<a href="/dashboard/drive-1/pub">pub</a>',
      '<a href="/dashboard/drive-1/priv">priv</a>',
    ].join('');
    const map = new Map([['pub', 'p']]);

    const out = rewriteInterPageLinks(html, map, SUB);
    expect(out).toContain('href="https://acme.pagespace.site/p"');
    expect(out).toContain('href="/dashboard/drive-1/priv"');
  });
});
