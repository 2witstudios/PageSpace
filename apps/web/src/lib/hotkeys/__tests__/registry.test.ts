import { describe, it, expect } from 'vitest';
import {
  HOTKEY_REGISTRY,
  HOTKEY_CATEGORIES,
  getHotkeyDefinition,
  getHotkeysByCategory,
} from '../registry';

describe('hotkeys/registry', () => {
  describe('HOTKEY_CATEGORIES', () => {
    it('should have navigation, tabs, editing, and general categories', () => {
      expect(HOTKEY_CATEGORIES.navigation).toBeDefined();
      expect(HOTKEY_CATEGORIES.tabs).toBeDefined();
      expect(HOTKEY_CATEGORIES.editing).toBeDefined();
      expect(HOTKEY_CATEGORIES.general).toBeDefined();
    });

    it('should have labels and descriptions', () => {
      for (const cat of Object.values(HOTKEY_CATEGORIES)) {
        expect(cat.label).toBeTruthy();
        expect(cat.description).toBeTruthy();
      }
    });
  });

  describe('HOTKEY_REGISTRY', () => {
    it('should have unique IDs', () => {
      const ids = HOTKEY_REGISTRY.map(h => h.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have valid categories', () => {
      const validCategories = Object.keys(HOTKEY_CATEGORIES);
      for (const hotkey of HOTKEY_REGISTRY) {
        expect(validCategories).toContain(hotkey.category);
      }
    });

    it('should have defaultBinding for each hotkey', () => {
      for (const hotkey of HOTKEY_REGISTRY) {
        expect(hotkey.defaultBinding).toBeTruthy();
      }
    });
  });

  describe('getHotkeyDefinition', () => {
    it('should return definition for known hotkey', () => {
      const def = getHotkeyDefinition('navigation.search');
      expect(def).toBeDefined();
      expect(def!.label).toBe('Open Search');
    });

    it('should return undefined for unknown hotkey', () => {
      expect(getHotkeyDefinition('nonexistent')).toBeUndefined();
    });
  });

  describe('getHotkeysByCategory', () => {
    it('should return hotkeys grouped by category', () => {
      const groups = getHotkeysByCategory();
      expect(groups.navigation.length).toBeGreaterThan(0);
      expect(groups.tabs.length).toBeGreaterThan(0);
    });

    it('should have all hotkeys accounted for', () => {
      const groups = getHotkeysByCategory();
      const total = Object.values(groups).reduce((sum, arr) => sum + arr.length, 0);
      expect(total).toBe(HOTKEY_REGISTRY.length);
    });

    it('should have empty arrays for categories with no hotkeys', () => {
      const groups = getHotkeysByCategory();
      expect(Array.isArray(groups.editing)).toBe(true);
      expect(Array.isArray(groups.general)).toBe(true);
    });
  });
});
