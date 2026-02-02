/**
 * Tab Navigation Logic Tests
 * Pure functions for browser-style tab navigation with per-tab history
 */

import { describe, it, expect } from 'vitest';
import {
  createTab,
  navigateInTab,
  goBack,
  goForward,
  canGoBack,
  canGoForward,
  type Tab,
} from '../tab-navigation';
import { PageType } from '@pagespace/lib/client-safe';

// Factory for creating test tabs
const createTestTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: overrides.id ?? 'tab-1',
  path: overrides.path ?? '/dashboard',
  history: overrides.history ?? ['/dashboard'],
  historyIndex: overrides.historyIndex ?? 0,
  isPinned: overrides.isPinned ?? false,
  title: overrides.title,
  pageType: overrides.pageType,
});

describe('tab-navigation', () => {
  describe('createTab', () => {
    it('given no path, should create tab at /dashboard', () => {
      const tab = createTab();

      expect(tab.path).toBe('/dashboard');
      expect(tab.history).toEqual(['/dashboard']);
      expect(tab.historyIndex).toBe(0);
    });

    it('given a path, should create tab at that path', () => {
      const tab = createTab({ path: '/dashboard/drive-1/page-1' });

      expect(tab.path).toBe('/dashboard/drive-1/page-1');
      expect(tab.history).toEqual(['/dashboard/drive-1/page-1']);
      expect(tab.historyIndex).toBe(0);
    });

    it('given no id, should generate unique id', () => {
      const tab1 = createTab();
      const tab2 = createTab();

      expect(tab1.id).toBeDefined();
      expect(tab2.id).toBeDefined();
      expect(tab1.id).not.toBe(tab2.id);
    });

    it('given isPinned option, should set pinned state', () => {
      const tab = createTab({ isPinned: true });

      expect(tab.isPinned).toBe(true);
    });
  });

  describe('navigateInTab', () => {
    it('given a tab and new path, should update path and push to history', () => {
      const tab = createTestTab({ path: '/dashboard', history: ['/dashboard'], historyIndex: 0 });

      const updated = navigateInTab(tab, '/dashboard/drive-1/page-1');

      expect(updated.path).toBe('/dashboard/drive-1/page-1');
      expect(updated.history).toEqual(['/dashboard', '/dashboard/drive-1/page-1']);
      expect(updated.historyIndex).toBe(1);
    });

    it('given same path as current, should not modify history', () => {
      const tab = createTestTab({
        path: '/dashboard/drive-1/page-1',
        history: ['/dashboard', '/dashboard/drive-1/page-1'],
        historyIndex: 1,
      });

      const updated = navigateInTab(tab, '/dashboard/drive-1/page-1');

      expect(updated.history).toEqual(['/dashboard', '/dashboard/drive-1/page-1']);
      expect(updated.historyIndex).toBe(1);
    });

    it('given navigation after going back, should truncate forward history', () => {
      const tab = createTestTab({
        path: '/dashboard',
        history: ['/dashboard', '/page-1', '/page-2'],
        historyIndex: 0, // went back to start
      });

      const updated = navigateInTab(tab, '/page-3');

      expect(updated.path).toBe('/page-3');
      expect(updated.history).toEqual(['/dashboard', '/page-3']);
      expect(updated.historyIndex).toBe(1);
    });

    it('given navigation, should preserve isPinned', () => {
      const tab = createTestTab({ isPinned: true });

      const updated = navigateInTab(tab, '/new-path');

      expect(updated.isPinned).toBe(true);
    });

    it('given tab with cached metadata, should clear metadata when navigating to new path', () => {
      const tab = createTestTab({
        path: '/dashboard/drive-1/page-1',
        title: 'Old Page Title',
        pageType: PageType.DOCUMENT,
      });

      const updated = navigateInTab(tab, '/dashboard/drive-1/page-2');

      expect(updated.title).toBeUndefined();
      expect(updated.pageType).toBeUndefined();
    });

    it('given same path as current, should preserve cached metadata', () => {
      const tab = createTestTab({
        path: '/dashboard/drive-1/page-1',
        title: 'Page Title',
        pageType: PageType.DOCUMENT,
      });

      const updated = navigateInTab(tab, '/dashboard/drive-1/page-1');

      expect(updated.title).toBe('Page Title');
      expect(updated.pageType).toBe('DOCUMENT');
    });
  });

  describe('goBack', () => {
    it('given tab with history, should navigate to previous entry', () => {
      const tab = createTestTab({
        path: '/page-2',
        history: ['/dashboard', '/page-1', '/page-2'],
        historyIndex: 2,
      });

      const updated = goBack(tab);

      expect(updated.path).toBe('/page-1');
      expect(updated.historyIndex).toBe(1);
      expect(updated.history).toEqual(['/dashboard', '/page-1', '/page-2']); // history unchanged
    });

    it('given tab at start of history, should return unchanged', () => {
      const tab = createTestTab({
        path: '/dashboard',
        history: ['/dashboard', '/page-1'],
        historyIndex: 0,
      });

      const updated = goBack(tab);

      expect(updated.path).toBe('/dashboard');
      expect(updated.historyIndex).toBe(0);
    });

    it('given tab with cached metadata, should clear metadata when going back', () => {
      const tab = createTestTab({
        path: '/page-2',
        history: ['/dashboard', '/page-1', '/page-2'],
        historyIndex: 2,
        title: 'Page 2 Title',
        pageType: PageType.DOCUMENT,
      });

      const updated = goBack(tab);

      expect(updated.title).toBeUndefined();
      expect(updated.pageType).toBeUndefined();
    });
  });

  describe('goForward', () => {
    it('given tab with forward history, should navigate forward', () => {
      const tab = createTestTab({
        path: '/dashboard',
        history: ['/dashboard', '/page-1', '/page-2'],
        historyIndex: 0,
      });

      const updated = goForward(tab);

      expect(updated.path).toBe('/page-1');
      expect(updated.historyIndex).toBe(1);
    });

    it('given tab at end of history, should return unchanged', () => {
      const tab = createTestTab({
        path: '/page-2',
        history: ['/dashboard', '/page-1', '/page-2'],
        historyIndex: 2,
      });

      const updated = goForward(tab);

      expect(updated.path).toBe('/page-2');
      expect(updated.historyIndex).toBe(2);
    });

    it('given tab with cached metadata, should clear metadata when going forward', () => {
      const tab = createTestTab({
        path: '/dashboard',
        history: ['/dashboard', '/page-1', '/page-2'],
        historyIndex: 0,
        title: 'Dashboard',
        pageType: PageType.DOCUMENT,
      });

      const updated = goForward(tab);

      expect(updated.title).toBeUndefined();
      expect(updated.pageType).toBeUndefined();
    });
  });

  describe('canGoBack', () => {
    it('given tab at start of history, should return false', () => {
      const tab = createTestTab({ historyIndex: 0 });

      expect(canGoBack(tab)).toBe(false);
    });

    it('given tab with back history, should return true', () => {
      const tab = createTestTab({
        history: ['/dashboard', '/page-1'],
        historyIndex: 1,
      });

      expect(canGoBack(tab)).toBe(true);
    });
  });

  describe('canGoForward', () => {
    it('given tab at end of history, should return false', () => {
      const tab = createTestTab({
        history: ['/dashboard', '/page-1'],
        historyIndex: 1,
      });

      expect(canGoForward(tab)).toBe(false);
    });

    it('given tab with forward history, should return true', () => {
      const tab = createTestTab({
        history: ['/dashboard', '/page-1', '/page-2'],
        historyIndex: 0,
      });

      expect(canGoForward(tab)).toBe(true);
    });
  });
});
