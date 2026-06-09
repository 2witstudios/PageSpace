import { describe, it, expect, vi } from 'vitest';
import { buildPageContext } from '../buildPageContext';
import type { PageContextInput } from '../buildPageContext';

const PAGE = { id: 'page1', title: 'My Page', type: 'AI_CHAT' as const };
const DRIVE_ID = 'drive-abc';
const DRIVE = { id: 'drive-abc', name: 'My Drive', slug: 'my-drive' };

function makeInput(overrides: Partial<PageContextInput> = {}): PageContextInput {
  return {
    page: PAGE,
    driveId: DRIVE_ID,
    drives: [DRIVE],
    cachedTree: [],
    fetchBreadcrumbs: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('buildPageContext', () => {
  describe('drive context', () => {
    it('uses drive from drives array when found', async () => {
      const result = await buildPageContext(makeInput({ drives: [DRIVE] }));
      expect(result.driveId).toBe('drive-abc');
      expect(result.driveName).toBe('My Drive');
      expect(result.driveSlug).toBe('my-drive');
    });

    it('falls back to driveId string when drives array is empty', async () => {
      const result = await buildPageContext(makeInput({ drives: [] }));
      expect(result.driveId).toBe(DRIVE_ID);
      expect(result.driveName).toBe(DRIVE_ID);
      expect(result.driveSlug).toBeUndefined();
    });

    it('falls back to driveId string when drive is not in the array', async () => {
      const otherDrive = { id: 'other-drive', name: 'Other', slug: 'other' };
      const result = await buildPageContext(makeInput({ drives: [otherDrive] }));
      expect(result.driveId).toBe(DRIVE_ID);
    });
  });

  describe('page identity fields', () => {
    it('always includes page id, title, and type', async () => {
      const result = await buildPageContext(makeInput());
      expect(result.pageId).toBe('page1');
      expect(result.pageTitle).toBe('My Page');
      expect(result.pageType).toBe('AI_CHAT');
    });
  });

  describe('path from tree cache', () => {
    it('derives path from cached tree without calling fetchBreadcrumbs', async () => {
      const cachedTree = [
        {
          id: 'folder1',
          title: 'Folder',
          children: [
            { id: 'page1', title: 'My Page', children: [] },
          ],
        },
      ];
      const fetchBreadcrumbs = vi.fn();
      const result = await buildPageContext(makeInput({ cachedTree, fetchBreadcrumbs }));
      expect(result.pagePath).toBe(`/${DRIVE_ID}/Folder/My Page`);
      expect(result.parentPath).toBe(`/${DRIVE_ID}/Folder`);
      expect(result.breadcrumbs).toEqual([DRIVE_ID, 'Folder', 'My Page']);
      expect(fetchBreadcrumbs).not.toHaveBeenCalled();
    });

    it('falls back to safe defaults when page is not in empty tree', async () => {
      const fetchBreadcrumbs = vi.fn().mockResolvedValue([]);
      const result = await buildPageContext(makeInput({ cachedTree: [], fetchBreadcrumbs }));
      expect(result.pagePath).toBe(`/${DRIVE_ID}/My Page`);
      expect(result.parentPath).toBe(`/${DRIVE_ID}`);
      expect(result.breadcrumbs).toEqual([DRIVE_ID, 'My Page']);
    });
  });

  describe('breadcrumbs fallback', () => {
    it('calls fetchBreadcrumbs when page is not in cached tree', async () => {
      const fetchBreadcrumbs = vi.fn().mockResolvedValue([
        { title: 'Parent Folder' },
        { title: 'My Page' },
      ]);
      await buildPageContext(makeInput({ cachedTree: [], fetchBreadcrumbs }));
      expect(fetchBreadcrumbs).toHaveBeenCalledWith('page1');
    });

    it('builds path from breadcrumbs API response', async () => {
      const fetchBreadcrumbs = vi.fn().mockResolvedValue([
        { title: 'Parent Folder' },
        { title: 'My Page' },
      ]);
      const result = await buildPageContext(makeInput({ cachedTree: [], fetchBreadcrumbs }));
      expect(result.pagePath).toBe(`/${DRIVE_ID}/Parent%20Folder/My%20Page`);
      expect(result.parentPath).toBe(`/${DRIVE_ID}/Parent%20Folder`);
      expect(result.breadcrumbs).toEqual([DRIVE_ID, 'Parent Folder', 'My Page']);
    });

    it('uses safe defaults when fetchBreadcrumbs throws', async () => {
      const fetchBreadcrumbs = vi.fn().mockRejectedValue(new Error('network error'));
      const result = await buildPageContext(makeInput({ cachedTree: [], fetchBreadcrumbs }));
      expect(result.pagePath).toBe(`/${DRIVE_ID}/My Page`);
      expect(result.breadcrumbs).toEqual([DRIVE_ID, 'My Page']);
    });

    it('uses safe defaults when fetchBreadcrumbs returns empty array', async () => {
      const fetchBreadcrumbs = vi.fn().mockResolvedValue([]);
      const result = await buildPageContext(makeInput({ cachedTree: [], fetchBreadcrumbs }));
      expect(result.pagePath).toBe(`/${DRIVE_ID}/My Page`);
    });

    it('filters out breadcrumb items with no title', async () => {
      const fetchBreadcrumbs = vi.fn().mockResolvedValue([
        { title: '' },
        { title: 'Real Folder' },
        { title: 'My Page' },
      ]);
      const result = await buildPageContext(makeInput({ cachedTree: [], fetchBreadcrumbs }));
      expect(result.breadcrumbs).toEqual([DRIVE_ID, 'Real Folder', 'My Page']);
    });
  });
});
