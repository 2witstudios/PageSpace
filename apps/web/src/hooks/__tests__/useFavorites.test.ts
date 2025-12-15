/**
 * useFavorites Tests
 * Tests for favorites state management with Set persistence
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useFavorites } from '../useFavorites';

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

describe('useFavorites', () => {
  beforeEach(() => {
    // Reset the store before each test
    useFavorites.setState({ favorites: new Set() });
    mockLocalStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have empty favorites set', () => {
      const { favorites } = useFavorites.getState();
      expect(favorites.size).toBe(0);
    });
  });

  describe('addFavorite', () => {
    it('given a page ID, should add it to favorites', () => {
      const { addFavorite } = useFavorites.getState();

      addFavorite('page-123');

      const { favorites } = useFavorites.getState();
      expect(favorites.has('page-123')).toBe(true);
    });

    it('given multiple page IDs, should add all of them', () => {
      const { addFavorite } = useFavorites.getState();

      addFavorite('page-1');
      addFavorite('page-2');
      addFavorite('page-3');

      const { favorites } = useFavorites.getState();
      expect(favorites.size).toBe(3);
      expect(favorites.has('page-1')).toBe(true);
      expect(favorites.has('page-2')).toBe(true);
      expect(favorites.has('page-3')).toBe(true);
    });

    it('given duplicate page ID, should not create duplicates', () => {
      const { addFavorite } = useFavorites.getState();

      addFavorite('page-123');
      addFavorite('page-123');

      const { favorites } = useFavorites.getState();
      expect(favorites.size).toBe(1);
    });
  });

  describe('removeFavorite', () => {
    it('given a favorited page ID, should remove it', () => {
      useFavorites.setState({ favorites: new Set(['page-123']) });
      const { removeFavorite } = useFavorites.getState();

      removeFavorite('page-123');

      const { favorites } = useFavorites.getState();
      expect(favorites.has('page-123')).toBe(false);
    });

    it('given a non-favorited page ID, should not throw', () => {
      const { removeFavorite } = useFavorites.getState();

      expect(() => {
        removeFavorite('non-existent');
      }).not.toThrow();
    });

    it('given multiple favorites, should only remove the specified one', () => {
      useFavorites.setState({ favorites: new Set(['page-1', 'page-2', 'page-3']) });
      const { removeFavorite } = useFavorites.getState();

      removeFavorite('page-2');

      const { favorites } = useFavorites.getState();
      expect(favorites.size).toBe(2);
      expect(favorites.has('page-1')).toBe(true);
      expect(favorites.has('page-2')).toBe(false);
      expect(favorites.has('page-3')).toBe(true);
    });
  });

  describe('isFavorite', () => {
    it('given a favorited page ID, should return true', () => {
      useFavorites.setState({ favorites: new Set(['page-123']) });
      const { isFavorite } = useFavorites.getState();

      expect(isFavorite('page-123')).toBe(true);
    });

    it('given a non-favorited page ID, should return false', () => {
      const { isFavorite } = useFavorites.getState();

      expect(isFavorite('non-existent')).toBe(false);
    });
  });

  describe('favorites workflow', () => {
    it('given typical user workflow, should manage favorites correctly', () => {
      const { addFavorite, removeFavorite, isFavorite } = useFavorites.getState();

      // User favorites some pages
      addFavorite('page-1');
      addFavorite('page-2');
      addFavorite('page-3');

      // Verify favorites
      expect(isFavorite('page-1')).toBe(true);
      expect(isFavorite('page-2')).toBe(true);
      expect(isFavorite('page-3')).toBe(true);

      // User unfavorites one
      removeFavorite('page-2');

      // Verify updated state
      expect(isFavorite('page-1')).toBe(true);
      expect(isFavorite('page-2')).toBe(false);
      expect(isFavorite('page-3')).toBe(true);
    });

    it('given toggle favorite pattern, should work correctly', () => {
      const { addFavorite, removeFavorite, isFavorite } = useFavorites.getState();

      // Toggle on
      addFavorite('page-123');
      expect(isFavorite('page-123')).toBe(true);

      // Toggle off
      removeFavorite('page-123');
      expect(isFavorite('page-123')).toBe(false);

      // Toggle on again
      addFavorite('page-123');
      expect(isFavorite('page-123')).toBe(true);
    });
  });

  describe('Set behavior', () => {
    it('should maintain Set semantics', () => {
      const { addFavorite } = useFavorites.getState();

      // Adding same ID multiple times
      for (let i = 0; i < 5; i++) {
        addFavorite('page-123');
      }

      const { favorites } = useFavorites.getState();
      expect(favorites.size).toBe(1);
    });

    it('should preserve insertion order in iterations', () => {
      const { addFavorite } = useFavorites.getState();

      addFavorite('page-1');
      addFavorite('page-2');
      addFavorite('page-3');

      const { favorites } = useFavorites.getState();
      const order = Array.from(favorites);
      expect(order).toEqual(['page-1', 'page-2', 'page-3']);
    });
  });
});
