import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseSWR = vi.hoisted(() => vi.fn());
const mockParseTabPath = vi.hoisted(() => vi.fn());
const mockGetStaticTabMeta = vi.hoisted(() => vi.fn());
const mockUseDriveStore = vi.hoisted(() => vi.fn());
const mockUpdateTabMeta = vi.hoisted(() => vi.fn());
const mockUseTabsStore = vi.hoisted(() => vi.fn());
const mockFetchWithAuth = vi.hoisted(() => vi.fn());

vi.mock('swr', () => ({
  default: mockUseSWR,
}));

vi.mock('@/lib/tabs/tab-title', () => ({
  parseTabPath: mockParseTabPath,
  getStaticTabMeta: mockGetStaticTabMeta,
}));

vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: mockUseDriveStore,
}));

vi.mock('@/stores/useTabsStore', () => ({
  useTabsStore: mockUseTabsStore,
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
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

import { useTabMeta } from '../useTabMeta';

function makeTab(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tab-1',
    path: '/dashboard',
    title: undefined as string | undefined,
    pageType: undefined as string | undefined,
    ...overrides,
  };
}

describe('useTabMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default SWR mock: returns no data, not loading
    mockUseSWR.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: undefined,
    });

    mockUseDriveStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
      selector({ drives: [] })
    );

    mockUseTabsStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
      selector({ updateTabMeta: mockUpdateTabMeta })
    );
  });

  describe('static routes', () => {
    it('should return static meta for dashboard route', () => {
      const tab = makeTab({ path: '/dashboard' });
      mockParseTabPath.mockReturnValue({ type: 'dashboard' });
      mockGetStaticTabMeta.mockReturnValue({ title: 'Dashboard', iconName: 'LayoutDashboard' });

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('Dashboard');
      expect(result.current.iconName).toBe('LayoutDashboard');
      expect(result.current.isLoading).toBe(false);
    });

    it('should return static meta for settings route', () => {
      const tab = makeTab({ path: '/settings' });
      mockParseTabPath.mockReturnValue({ type: 'settings' });
      mockGetStaticTabMeta.mockReturnValue({ title: 'Settings', iconName: 'Settings' });

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('Settings');
      expect(result.current.iconName).toBe('Settings');
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('drive tabs', () => {
    it('should return drive name from store for drive tabs', () => {
      const tab = makeTab({ path: '/dashboard/drive-1' });
      mockParseTabPath.mockReturnValue({ type: 'drive', driveId: 'drive-1' });
      mockGetStaticTabMeta.mockReturnValue(null);
      mockUseDriveStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          drives: [{ id: 'drive-1', name: 'My Drive' }],
        })
      );

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('My Drive');
      expect(result.current.iconName).toBe('LayoutDashboard');
      expect(result.current.isLoading).toBe(false);
    });

    it('should return fallback "Drive" when drive not found in store', () => {
      const tab = makeTab({ path: '/dashboard/drive-unknown' });
      mockParseTabPath.mockReturnValue({ type: 'drive', driveId: 'drive-unknown' });
      mockGetStaticTabMeta.mockReturnValue(null);
      mockUseDriveStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
        selector({ drives: [] })
      );

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('Drive');
    });
  });

  describe('page tabs', () => {
    it('should return cached title for page tabs when tab has title', () => {
      const tab = makeTab({
        path: '/dashboard/drive-1/page-1',
        title: 'My Document',
        pageType: 'DOCUMENT',
      });
      mockParseTabPath.mockReturnValue({ type: 'page', driveId: 'drive-1', pageId: 'page-1' });
      mockGetStaticTabMeta.mockReturnValue(null);

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('My Document');
      expect(result.current.iconName).toBe('FileText');
      expect(result.current.isLoading).toBe(false);
    });

    it('should return loading state for page tabs without cache', () => {
      const tab = makeTab({
        path: '/dashboard/drive-1/page-1',
        title: undefined,
      });
      mockParseTabPath.mockReturnValue({ type: 'page', driveId: 'drive-1', pageId: 'page-1' });
      mockGetStaticTabMeta.mockReturnValue(null);

      // SWR is loading
      mockUseSWR.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: undefined,
      });

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('Loading...');
      expect(result.current.isLoading).toBe(true);
    });

    it('should return fallback on error for page tabs', () => {
      const tab = makeTab({
        path: '/dashboard/drive-1/page-1',
        title: undefined,
      });
      mockParseTabPath.mockReturnValue({ type: 'page', driveId: 'drive-1', pageId: 'page-1' });
      mockGetStaticTabMeta.mockReturnValue(null);

      mockUseSWR.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: new Error('Not found'),
      });

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('Untitled');
      expect(result.current.iconName).toBe('File');
      expect(result.current.isLoading).toBe(false);
    });

    it('should return fetched data for page tabs when data arrives', () => {
      const tab = makeTab({
        path: '/dashboard/drive-1/page-1',
        title: undefined,
      });
      mockParseTabPath.mockReturnValue({ type: 'page', driveId: 'drive-1', pageId: 'page-1' });
      mockGetStaticTabMeta.mockReturnValue(null);

      // First SWR call (page data) returns data, second (DM) returns nothing
      let callCount = 0;
      mockUseSWR.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            data: { id: 'page-1', title: 'Fetched Title', type: 'DOCUMENT' },
            isLoading: false,
            error: undefined,
          };
        }
        return { data: undefined, isLoading: false, error: undefined };
      });

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('Fetched Title');
      expect(result.current.iconName).toBe('FileText');
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('channel tabs', () => {
    it('should prefix channel title with # when cached', () => {
      const tab = makeTab({
        path: '/dashboard/inbox/channel/ch-1',
        title: 'general',
        pageType: 'CHANNEL',
      });
      mockParseTabPath.mockReturnValue({ type: 'inbox-channel', pageId: 'ch-1' });
      mockGetStaticTabMeta.mockReturnValue(null);

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('#general');
      expect(result.current.iconName).toBe('Hash');
    });
  });

  describe('DM tabs', () => {
    it('should return cached DM title when tab has title', () => {
      const tab = makeTab({
        path: '/dashboard/inbox/dm/conv-1',
        title: 'DM - Alice',
      });
      mockParseTabPath.mockReturnValue({ type: 'inbox-dm', conversationId: 'conv-1' });
      mockGetStaticTabMeta.mockReturnValue(null);

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('DM - Alice');
      expect(result.current.iconName).toBe('MessageCircle');
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('fallback', () => {
    it('should return the path as title when route type is unknown', () => {
      const tab = makeTab({ path: '/unknown/route' });
      mockParseTabPath.mockReturnValue({ type: 'unknown', path: '/unknown/route' });
      mockGetStaticTabMeta.mockReturnValue(null);

      const { result } = renderHook(() => useTabMeta(tab as never));

      expect(result.current.title).toBe('/unknown/route');
      expect(result.current.iconName).toBe('File');
    });
  });
});
