import { describe, expect, it } from 'vitest';
import {
  extractDashboardFileViewRefs,
  rewriteDashboardFileViewLinks,
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
