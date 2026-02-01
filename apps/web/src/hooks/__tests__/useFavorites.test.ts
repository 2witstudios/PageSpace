/**
 * useFavorites Tests
 * Tests for favorites state management with database sync
 */

import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import { useFavorites } from '../useFavorites';
import type { FavoriteItem } from '@/app/api/user/favorites/route';

// Mock auth-fetch
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));

import { fetchWithAuth, post, del } from '@/lib/auth/auth-fetch';

// Mock localStorage
const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();

Object.defineProperty(global, 'localStorage', { value: mockLocalStorage });

// Helper to create mock favorite items
function createMockFavorite(overrides: Partial<FavoriteItem> = {}): FavoriteItem {
  return {
    id: 'fav-1',
    itemType: 'page',
    position: 0,
    createdAt: new Date().toISOString(),
    page: {
      id: 'page-123',
      title: 'Test Page',
      type: 'DOCUMENT',
      driveId: 'drive-1',
      driveName: 'Test Drive',
    },
    ...overrides,
  };
}

describe('useFavorites', () => {
  beforeEach(() => {
    // Reset the store before each test
    useFavorites.setState({
      favorites: [],
      pageIds: new Set(),
      driveIds: new Set(),
      isLoading: false,
      isSynced: false,
    });
    mockLocalStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have empty favorites', () => {
      const state = useFavorites.getState();
      expect(state.favorites).toHaveLength(0);
      expect(state.pageIds.size).toBe(0);
      expect(state.driveIds.size).toBe(0);
      expect(state.isSynced).toBe(false);
    });
  });

  describe('fetchFavorites', () => {
    it('given API returns favorites, should populate state correctly', async () => {
      const mockFavorites: FavoriteItem[] = [
        createMockFavorite({ id: 'fav-1', page: { id: 'page-1', title: 'Page 1', type: 'DOCUMENT', driveId: 'd1', driveName: 'Drive' } }),
        createMockFavorite({ id: 'fav-2', itemType: 'drive', page: undefined, drive: { id: 'drive-1', name: 'Test Drive' } }),
      ];

      (fetchWithAuth as Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ favorites: mockFavorites }),
      });

      await useFavorites.getState().fetchFavorites();

      const state = useFavorites.getState();
      expect(state.favorites).toHaveLength(2);
      expect(state.pageIds.has('page-1')).toBe(true);
      expect(state.driveIds.has('drive-1')).toBe(true);
      expect(state.isSynced).toBe(true);
    });

    it('given API fails, should handle error gracefully', async () => {
      (fetchWithAuth as Mock).mockRejectedValue(new Error('Network error'));

      await useFavorites.getState().fetchFavorites();

      const state = useFavorites.getState();
      expect(state.isLoading).toBe(false);
      expect(state.isSynced).toBe(false);
    });

    it('given already loading, should not make duplicate request', async () => {
      useFavorites.setState({ isLoading: true });

      await useFavorites.getState().fetchFavorites();

      expect(fetchWithAuth).not.toHaveBeenCalled();
    });
  });

  describe('isFavorite', () => {
    it('given a favorited page ID, should return true', () => {
      useFavorites.setState({
        favorites: [createMockFavorite({ page: { id: 'page-123', title: 'Test', type: 'DOCUMENT', driveId: 'd1', driveName: 'D' } })],
        pageIds: new Set(['page-123']),
        driveIds: new Set(),
      });

      expect(useFavorites.getState().isFavorite('page-123')).toBe(true);
      expect(useFavorites.getState().isFavorite('page-123', 'page')).toBe(true);
    });

    it('given a favorited drive ID, should return true when checking drive type', () => {
      useFavorites.setState({
        favorites: [createMockFavorite({ itemType: 'drive', page: undefined, drive: { id: 'drive-1', name: 'Test' } })],
        pageIds: new Set(),
        driveIds: new Set(['drive-1']),
      });

      expect(useFavorites.getState().isFavorite('drive-1', 'drive')).toBe(true);
      // Without itemType, defaults to page
      expect(useFavorites.getState().isFavorite('drive-1')).toBe(false);
    });

    it('given a non-favorited ID, should return false', () => {
      expect(useFavorites.getState().isFavorite('non-existent')).toBe(false);
    });
  });

  describe('addFavorite', () => {
    it('given a page ID, should optimistically add and call API', async () => {
      (post as Mock).mockResolvedValue({});
      (fetchWithAuth as Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ favorites: [createMockFavorite()] }),
      });

      await useFavorites.getState().addFavorite('page-123', 'page');

      expect(post).toHaveBeenCalledWith('/api/user/favorites', { itemType: 'page', itemId: 'page-123' });
      expect(fetchWithAuth).toHaveBeenCalled(); // Refetches after add
    });

    it('given a drive ID, should add to driveIds', async () => {
      (post as Mock).mockResolvedValue({});
      (fetchWithAuth as Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ favorites: [] }),
      });

      const addPromise = useFavorites.getState().addFavorite('drive-1', 'drive');

      // Check optimistic update
      expect(useFavorites.getState().driveIds.has('drive-1')).toBe(true);

      await addPromise;
    });

    it('given API fails, should rollback optimistic update', async () => {
      (post as Mock).mockRejectedValue(new Error('API error'));

      await expect(useFavorites.getState().addFavorite('page-123', 'page')).rejects.toThrow();

      // Should have rolled back
      expect(useFavorites.getState().pageIds.has('page-123')).toBe(false);
    });
  });

  describe('removeFavorite', () => {
    it('given a favorited page, should optimistically remove and call API', async () => {
      useFavorites.setState({
        favorites: [createMockFavorite({ id: 'fav-1', page: { id: 'page-123', title: 'Test', type: 'DOCUMENT', driveId: 'd1', driveName: 'D' } })],
        pageIds: new Set(['page-123']),
        driveIds: new Set(),
      });

      (del as Mock).mockResolvedValue({});
      (fetchWithAuth as Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ favorites: [] }),
      });

      await useFavorites.getState().removeFavorite('page-123', 'page');

      expect(del).toHaveBeenCalledWith('/api/user/favorites/fav-1');
    });

    it('given page not in favorites, should just update local state', async () => {
      useFavorites.setState({
        favorites: [],
        pageIds: new Set(['page-123']), // In local set but not synced
        driveIds: new Set(),
      });

      await useFavorites.getState().removeFavorite('page-123', 'page');

      expect(del).not.toHaveBeenCalled();
      expect(useFavorites.getState().pageIds.has('page-123')).toBe(false);
    });
  });

  describe('removeFavoriteById', () => {
    it('given a favorite ID, should remove and call API', async () => {
      useFavorites.setState({
        favorites: [createMockFavorite({ id: 'fav-1', page: { id: 'page-123', title: 'Test', type: 'DOCUMENT', driveId: 'd1', driveName: 'D' } })],
        pageIds: new Set(['page-123']),
        driveIds: new Set(),
      });

      (del as Mock).mockResolvedValue({});

      await useFavorites.getState().removeFavoriteById('fav-1');

      expect(del).toHaveBeenCalledWith('/api/user/favorites/fav-1');
      expect(useFavorites.getState().favorites).toHaveLength(0);
    });

    it('given non-existent favorite ID, should do nothing', async () => {
      await useFavorites.getState().removeFavoriteById('non-existent');

      expect(del).not.toHaveBeenCalled();
    });
  });

  describe('getFavoriteId', () => {
    it('given a favorited page, should return favorite ID', () => {
      useFavorites.setState({
        favorites: [createMockFavorite({ id: 'fav-1', page: { id: 'page-123', title: 'Test', type: 'DOCUMENT', driveId: 'd1', driveName: 'D' } })],
        pageIds: new Set(['page-123']),
        driveIds: new Set(),
      });

      expect(useFavorites.getState().getFavoriteId('page-123', 'page')).toBe('fav-1');
    });

    it('given a favorited drive, should return favorite ID', () => {
      useFavorites.setState({
        favorites: [createMockFavorite({ id: 'fav-2', itemType: 'drive', page: undefined, drive: { id: 'drive-1', name: 'Test' } })],
        pageIds: new Set(),
        driveIds: new Set(['drive-1']),
      });

      expect(useFavorites.getState().getFavoriteId('drive-1', 'drive')).toBe('fav-2');
    });

    it('given non-favorited item, should return undefined', () => {
      expect(useFavorites.getState().getFavoriteId('non-existent', 'page')).toBeUndefined();
    });
  });

  describe('favorites workflow', () => {
    it('given typical user workflow, should manage favorites correctly', async () => {
      // Setup mocks
      (post as Mock).mockResolvedValue({});
      (del as Mock).mockResolvedValue({});
      (fetchWithAuth as Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ favorites: [] }),
      });

      const { addFavorite, isFavorite } = useFavorites.getState();

      // User favorites a page
      await addFavorite('page-1', 'page');

      // Optimistic update should be visible
      expect(isFavorite('page-1', 'page')).toBe(true);

      // User favorites a drive
      await addFavorite('drive-1', 'drive');
      expect(isFavorite('drive-1', 'drive')).toBe(true);
    });
  });
});
