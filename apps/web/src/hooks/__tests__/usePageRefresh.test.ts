import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseParams = vi.hoisted(() => vi.fn(() => ({})));
const mockUsePathname = vi.hoisted(() => vi.fn(() => '/'));
const mockMutate = vi.hoisted(() => vi.fn());
const mockUsePageTree = vi.hoisted(() => vi.fn(() => ({ tree: [], mutate: mockMutate })));
const mockFindNodeAndParent = vi.hoisted(() => vi.fn(() => null));

vi.mock('next/navigation', () => ({
  useParams: mockUseParams,
  usePathname: mockUsePathname,
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('../usePageTree', () => ({
  usePageTree: mockUsePageTree,
}));

vi.mock('@/lib/tree/tree-utils', () => ({
  findNodeAndParent: mockFindNodeAndParent,
}));

vi.mock('@pagespace/lib/client-safe', () => ({
  PageType: {
    FOLDER: 'FOLDER',
    DOCUMENT: 'DOCUMENT',
    CHANNEL: 'CHANNEL',
    AI_CHAT: 'AI_CHAT',
    CANVAS: 'CANVAS',
    FILE: 'FILE',
    SHEET: 'SHEET',
    TASK_LIST: 'TASK_LIST',
    CODE: 'CODE',
  },
}));

import { usePageRefresh } from '../usePageRefresh';

function makeTreePage(type: string, id = 'page-1') {
  return {
    id,
    type,
    title: 'Test Page',
    children: [],
    aiChat: null,
    messages: [],
  };
}

describe('usePageRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseParams.mockReturnValue({});
    mockUsePathname.mockReturnValue('/');
    mockUsePageTree.mockReturnValue({ tree: [], mutate: mockMutate });
    mockFindNodeAndParent.mockReturnValue(null);
  });

  describe('settings pages', () => {
    it('should return canRefresh=true when pathname ends with /settings', () => {
      mockUsePathname.mockReturnValue('/dashboard/drive-1/settings');
      mockUseParams.mockReturnValue({ driveId: 'drive-1' });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(true);
    });

    it('should return canRefresh=true when pathname ends with /settings/mcp', () => {
      mockUsePathname.mockReturnValue('/dashboard/drive-1/settings/mcp');
      mockUseParams.mockReturnValue({ driveId: 'drive-1' });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(true);
    });
  });

  describe('page types that allow refresh', () => {
    it('should return canRefresh=true when page type is FOLDER', () => {
      const page = makeTreePage('FOLDER');
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
      mockUsePageTree.mockReturnValue({ tree: [page], mutate: mockMutate });
      mockFindNodeAndParent.mockReturnValue({ node: page, parent: null });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(true);
    });

    it('should return canRefresh=true when page type is TASK_LIST', () => {
      const page = makeTreePage('TASK_LIST');
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
      mockUsePageTree.mockReturnValue({ tree: [page], mutate: mockMutate });
      mockFindNodeAndParent.mockReturnValue({ node: page, parent: null });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(true);
    });

    it('should return canRefresh=true when page type is FILE', () => {
      const page = makeTreePage('FILE');
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
      mockUsePageTree.mockReturnValue({ tree: [page], mutate: mockMutate });
      mockFindNodeAndParent.mockReturnValue({ node: page, parent: null });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(true);
    });
  });

  describe('page types that disallow refresh', () => {
    it('should return canRefresh=false when page type is DOCUMENT', () => {
      const page = makeTreePage('DOCUMENT');
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
      mockUsePageTree.mockReturnValue({ tree: [page], mutate: mockMutate });
      mockFindNodeAndParent.mockReturnValue({ node: page, parent: null });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(false);
      expect(result.current.disabledReason).toBe('Editing content');
    });

    it('should return canRefresh=false when page type is SHEET', () => {
      const page = makeTreePage('SHEET');
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
      mockUsePageTree.mockReturnValue({ tree: [page], mutate: mockMutate });
      mockFindNodeAndParent.mockReturnValue({ node: page, parent: null });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(false);
      expect(result.current.disabledReason).toBe('Editing content');
    });

    it('should return canRefresh=false when page type is CANVAS', () => {
      const page = makeTreePage('CANVAS');
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
      mockUsePageTree.mockReturnValue({ tree: [page], mutate: mockMutate });
      mockFindNodeAndParent.mockReturnValue({ node: page, parent: null });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(false);
      expect(result.current.disabledReason).toBe('Editing content');
    });

    it('should return canRefresh=false when page type is AI_CHAT', () => {
      const page = makeTreePage('AI_CHAT');
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
      mockUsePageTree.mockReturnValue({ tree: [page], mutate: mockMutate });
      mockFindNodeAndParent.mockReturnValue({ node: page, parent: null });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(false);
      expect(result.current.disabledReason).toBe('Uses pull-up refresh instead');
    });

    it('should return canRefresh=false when page type is CHANNEL', () => {
      const page = makeTreePage('CHANNEL');
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
      mockUsePageTree.mockReturnValue({ tree: [page], mutate: mockMutate });
      mockFindNodeAndParent.mockReturnValue({ node: page, parent: null });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(false);
      expect(result.current.disabledReason).toBe('Uses pull-up refresh instead');
    });
  });

  describe('no current page', () => {
    it('should return canRefresh=false when no page is selected', () => {
      mockUseParams.mockReturnValue({ driveId: 'drive-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1');

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(false);
      expect(result.current.disabledReason).toBe('No page selected');
    });

    it('should return canRefresh=false when pageId exists but page is not found in tree', () => {
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'nonexistent' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/nonexistent');
      mockFindNodeAndParent.mockReturnValue(null);

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(false);
      expect(result.current.disabledReason).toBe('No page selected');
    });
  });

  describe('default behavior', () => {
    it('should return canRefresh=true for unknown page types (default case)', () => {
      const page = makeTreePage('CODE');
      mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
      mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
      mockUsePageTree.mockReturnValue({ tree: [page], mutate: mockMutate });
      mockFindNodeAndParent.mockReturnValue({ node: page, parent: null });

      const { result } = renderHook(() => usePageRefresh());

      expect(result.current.canRefresh).toBe(true);
    });
  });

  describe('refresh function', () => {
    it('should provide a refresh function that calls mutate', async () => {
      mockUsePathname.mockReturnValue('/dashboard/drive-1/settings');
      mockUseParams.mockReturnValue({ driveId: 'drive-1' });

      const { result } = renderHook(() => usePageRefresh());

      await result.current.refresh();

      expect(mockMutate).toHaveBeenCalled();
    });
  });
});
