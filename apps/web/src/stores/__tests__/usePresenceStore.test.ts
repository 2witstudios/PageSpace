/**
 * usePresenceStore Tests
 * Tests for the Zustand store that tracks page viewing presence.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { usePresenceStore } from '../usePresenceStore';
import type { PresenceViewer } from '@/lib/websocket';

const createViewer = (overrides: Partial<PresenceViewer> = {}): PresenceViewer => ({
  userId: 'user-1',
  socketId: 'socket-1',
  name: 'Alice',
  avatarUrl: null,
  ...overrides,
});

describe('usePresenceStore', () => {
  beforeEach(() => {
    usePresenceStore.setState({ pageViewers: new Map() });
  });

  describe('setPageViewers', () => {
    it('given viewers for a page, should store them', () => {
      const viewers = [createViewer()];

      usePresenceStore.getState().setPageViewers('page-1', viewers);

      const stored = usePresenceStore.getState().pageViewers.get('page-1');
      expect(stored).toEqual(viewers);
    });

    it('given empty viewers array, should remove the page entry', () => {
      const viewers = [createViewer()];
      usePresenceStore.getState().setPageViewers('page-1', viewers);

      usePresenceStore.getState().setPageViewers('page-1', []);

      expect(usePresenceStore.getState().pageViewers.has('page-1')).toBe(false);
    });

    it('given updates to the same page, should replace previous viewers', () => {
      const oldViewers = [createViewer({ name: 'Old' })];
      const newViewers = [createViewer({ name: 'New' })];

      usePresenceStore.getState().setPageViewers('page-1', oldViewers);
      usePresenceStore.getState().setPageViewers('page-1', newViewers);

      const stored = usePresenceStore.getState().pageViewers.get('page-1');
      expect(stored).toEqual(newViewers);
    });

    it('given viewers for different pages, should track them independently', () => {
      const viewers1 = [createViewer({ userId: 'user-1' })];
      const viewers2 = [createViewer({ userId: 'user-2', name: 'Bob' })];

      usePresenceStore.getState().setPageViewers('page-1', viewers1);
      usePresenceStore.getState().setPageViewers('page-2', viewers2);

      expect(usePresenceStore.getState().pageViewers.get('page-1')).toEqual(viewers1);
      expect(usePresenceStore.getState().pageViewers.get('page-2')).toEqual(viewers2);
    });
  });

  describe('getPageViewers', () => {
    it('given a page with viewers, should return them', () => {
      const viewers = [createViewer()];
      usePresenceStore.getState().setPageViewers('page-1', viewers);

      const result = usePresenceStore.getState().getPageViewers('page-1');

      expect(result).toEqual(viewers);
    });

    it('given an unknown page, should return empty array', () => {
      const result = usePresenceStore.getState().getPageViewers('nonexistent');

      expect(result).toEqual([]);
    });
  });

  describe('clearAll', () => {
    it('given pages with viewers, should remove all presence data', () => {
      usePresenceStore.getState().setPageViewers('page-1', [createViewer()]);
      usePresenceStore.getState().setPageViewers('page-2', [createViewer({ userId: 'user-2' })]);

      usePresenceStore.getState().clearAll();

      expect(usePresenceStore.getState().pageViewers.size).toBe(0);
    });
  });
});
