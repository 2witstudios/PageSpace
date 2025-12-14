/**
 * useDrive (useDriveStore) Tests
 * Tests for drive state management with caching and persistence
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useDriveStore, type Drive } from '../useDrive';

// Mock fetchWithAuth
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

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

// Helper to create mock drive
const createMockDrive = (overrides: Partial<Drive> = {}): Drive => ({
  id: 'drive-' + Math.random().toString(36).substr(2, 9),
  name: 'Test Drive',
  slug: 'test-drive',
  createdAt: new Date(),
  updatedAt: new Date(),
  ownerId: 'user-123',
  isDeleted: false,
  deletedAt: null,
  ...overrides,
});

describe('useDriveStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    useDriveStore.setState({
      drives: [],
      currentDriveId: null,
      isLoading: false,
      lastFetched: 0,
    });
    mockLocalStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have empty drives array', () => {
      const { drives } = useDriveStore.getState();
      expect(drives).toEqual([]);
    });

    it('given store is created, should have null currentDriveId', () => {
      const { currentDriveId } = useDriveStore.getState();
      expect(currentDriveId).toBeNull();
    });

    it('given store is created, should not be loading', () => {
      const { isLoading } = useDriveStore.getState();
      expect(isLoading).toBe(false);
    });

    it('given store is created, should have lastFetched at 0', () => {
      const { lastFetched } = useDriveStore.getState();
      expect(lastFetched).toBe(0);
    });
  });

  describe('fetchDrives', () => {
    it('given successful API response, should update drives', async () => {
      const mockDrives = [createMockDrive(), createMockDrive()];
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockDrives),
      });

      await useDriveStore.getState().fetchDrives();

      expect(useDriveStore.getState().drives).toEqual(mockDrives);
      expect(useDriveStore.getState().isLoading).toBe(false);
    });

    it('given includeTrash=true, should call API with query param', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await useDriveStore.getState().fetchDrives(true);

      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/drives?includeTrash=true');
    });

    it('given includeTrash=false, should call API without query param', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await useDriveStore.getState().fetchDrives(false);

      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/drives');
    });

    it('given recent fetch and data exists, should skip API call (cache)', async () => {
      useDriveStore.setState({
        drives: [createMockDrive()],
        lastFetched: Date.now() - 1000, // 1 second ago
      });

      await useDriveStore.getState().fetchDrives();

      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    it('given forceRefresh=true, should bypass cache', async () => {
      useDriveStore.setState({
        drives: [createMockDrive()],
        lastFetched: Date.now() - 1000,
      });
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await useDriveStore.getState().fetchDrives(false, true);

      expect(mockFetchWithAuth).toHaveBeenCalled();
    });

    it('given stale cache beyond duration, should refetch', async () => {
      useDriveStore.setState({
        drives: [createMockDrive()],
        lastFetched: Date.now() - 6 * 60 * 1000, // 6 minutes ago (beyond 5 min cache)
      });
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await useDriveStore.getState().fetchDrives();

      expect(mockFetchWithAuth).toHaveBeenCalled();
    });

    it('given API error, should set loading to false', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: false });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await useDriveStore.getState().fetchDrives(false, true);

      expect(useDriveStore.getState().isLoading).toBe(false);
      consoleError.mockRestore();
    });

    it('given successful fetch, should update lastFetched', async () => {
      const before = Date.now();
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await useDriveStore.getState().fetchDrives(false, true);

      expect(useDriveStore.getState().lastFetched).toBeGreaterThanOrEqual(before);
    });
  });

  describe('addDrive', () => {
    it('given a new drive, should add it to the array', () => {
      const existingDrive = createMockDrive({ id: 'existing' });
      useDriveStore.setState({ drives: [existingDrive] });

      const newDrive = createMockDrive({ id: 'new-drive' });
      useDriveStore.getState().addDrive(newDrive);

      const { drives } = useDriveStore.getState();
      expect(drives).toHaveLength(2);
      expect(drives[1].id).toBe('new-drive');
    });

    it('given addDrive called, should update lastFetched', () => {
      const before = Date.now();

      useDriveStore.getState().addDrive(createMockDrive());

      expect(useDriveStore.getState().lastFetched).toBeGreaterThanOrEqual(before);
    });
  });

  describe('removeDrive', () => {
    it('given a drive ID, should remove it from the array', () => {
      const drives = [
        createMockDrive({ id: 'keep-1' }),
        createMockDrive({ id: 'remove' }),
        createMockDrive({ id: 'keep-2' }),
      ];
      useDriveStore.setState({ drives });

      useDriveStore.getState().removeDrive('remove');

      const { drives: updatedDrives } = useDriveStore.getState();
      expect(updatedDrives).toHaveLength(2);
      expect(updatedDrives.map(d => d.id)).not.toContain('remove');
    });

    it('given a non-existent drive ID, should not throw', () => {
      useDriveStore.setState({ drives: [createMockDrive()] });

      expect(() => {
        useDriveStore.getState().removeDrive('non-existent');
      }).not.toThrow();
    });

    it('given removeDrive called, should update lastFetched', () => {
      useDriveStore.setState({ drives: [createMockDrive({ id: 'to-remove' })] });
      const before = Date.now();

      useDriveStore.getState().removeDrive('to-remove');

      expect(useDriveStore.getState().lastFetched).toBeGreaterThanOrEqual(before);
    });
  });

  describe('updateDrive', () => {
    it('given a drive ID and updates, should update the drive', () => {
      const drive = createMockDrive({ id: 'to-update', name: 'Old Name' });
      useDriveStore.setState({ drives: [drive] });

      useDriveStore.getState().updateDrive('to-update', { name: 'New Name' });

      const { drives } = useDriveStore.getState();
      expect(drives[0].name).toBe('New Name');
    });

    it('given partial updates, should preserve other properties', () => {
      const drive = createMockDrive({ id: 'to-update', name: 'Old Name', slug: 'old-slug' });
      useDriveStore.setState({ drives: [drive] });

      useDriveStore.getState().updateDrive('to-update', { name: 'New Name' });

      const { drives } = useDriveStore.getState();
      expect(drives[0].name).toBe('New Name');
      expect(drives[0].slug).toBe('old-slug');
    });

    it('given multiple drives, should only update the specified one', () => {
      const drives = [
        createMockDrive({ id: 'drive-1', name: 'Drive 1' }),
        createMockDrive({ id: 'drive-2', name: 'Drive 2' }),
      ];
      useDriveStore.setState({ drives });

      useDriveStore.getState().updateDrive('drive-1', { name: 'Updated Drive 1' });

      const { drives: updatedDrives } = useDriveStore.getState();
      expect(updatedDrives[0].name).toBe('Updated Drive 1');
      expect(updatedDrives[1].name).toBe('Drive 2');
    });

    it('given updateDrive called, should update lastFetched', () => {
      useDriveStore.setState({ drives: [createMockDrive({ id: 'to-update' })] });
      const before = Date.now();

      useDriveStore.getState().updateDrive('to-update', { name: 'New Name' });

      expect(useDriveStore.getState().lastFetched).toBeGreaterThanOrEqual(before);
    });
  });

  describe('setCurrentDrive', () => {
    it('given a drive ID, should set it as current', () => {
      useDriveStore.getState().setCurrentDrive('drive-123');

      expect(useDriveStore.getState().currentDriveId).toBe('drive-123');
    });

    it('given null, should clear current drive', () => {
      useDriveStore.setState({ currentDriveId: 'drive-123' });

      useDriveStore.getState().setCurrentDrive(null);

      expect(useDriveStore.getState().currentDriveId).toBeNull();
    });
  });

  describe('drive management workflow', () => {
    it('given typical workflow, should manage drives correctly', async () => {
      // User logs in, fetches drives
      const initialDrives = [
        createMockDrive({ id: 'drive-1', name: 'Personal' }),
        createMockDrive({ id: 'drive-2', name: 'Work' }),
      ];
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(initialDrives),
      });

      await useDriveStore.getState().fetchDrives();

      // User selects a drive
      useDriveStore.getState().setCurrentDrive('drive-1');

      // User creates a new drive
      const newDrive = createMockDrive({ id: 'drive-3', name: 'Projects' });
      useDriveStore.getState().addDrive(newDrive);

      // User renames a drive
      useDriveStore.getState().updateDrive('drive-2', { name: 'Work - 2024' });

      // Verify final state
      const state = useDriveStore.getState();
      expect(state.drives).toHaveLength(3);
      expect(state.currentDriveId).toBe('drive-1');
      expect(state.drives.find(d => d.id === 'drive-2')?.name).toBe('Work - 2024');
    });
  });
});
