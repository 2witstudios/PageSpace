/**
 * PresenceTracker Tests
 * Tests for tracking which users are currently viewing which pages.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PresenceTracker, type PresenceUser } from '../presence-tracker';

const createUser = (overrides: Partial<PresenceUser> = {}): PresenceUser => ({
  userId: 'user-1',
  socketId: 'socket-1',
  name: 'Alice',
  avatarUrl: null,
  ...overrides,
});

describe('PresenceTracker', () => {
  let tracker: PresenceTracker;

  beforeEach(() => {
    tracker = new PresenceTracker();
  });

  describe('addViewer', () => {
    it('given a user joining a page, should return that user as a viewer', () => {
      const user = createUser();

      const viewers = tracker.addViewer('page-1', 'drive-1', user);

      expect(viewers).toEqual([user]);
    });

    it('given multiple users joining the same page, should return all viewers', () => {
      const user1 = createUser({ userId: 'user-1', socketId: 'socket-1', name: 'Alice' });
      const user2 = createUser({ userId: 'user-2', socketId: 'socket-2', name: 'Bob' });

      tracker.addViewer('page-1', 'drive-1', user1);
      const viewers = tracker.addViewer('page-1', 'drive-1', user2);

      expect(viewers).toHaveLength(2);
      expect(viewers).toContainEqual(user1);
      expect(viewers).toContainEqual(user2);
    });

    it('given a user joining multiple pages, should track them separately', () => {
      const user = createUser();

      tracker.addViewer('page-1', 'drive-1', user);
      tracker.addViewer('page-2', 'drive-1', { ...user, socketId: 'socket-2' });

      expect(tracker.getViewers('page-1')).toHaveLength(1);
      expect(tracker.getViewers('page-2')).toHaveLength(1);
    });

    it('given the same socket joining a page twice, should overwrite (not duplicate)', () => {
      const user = createUser();

      tracker.addViewer('page-1', 'drive-1', user);
      tracker.addViewer('page-1', 'drive-1', { ...user, name: 'Alice Updated' });

      const viewers = tracker.getViewers('page-1');
      expect(viewers).toHaveLength(1);
      expect(viewers[0].name).toBe('Alice Updated');
    });
  });

  describe('removeViewer', () => {
    it('given a viewer leaving, should return updated viewer list without them', () => {
      const user1 = createUser({ userId: 'user-1', socketId: 'socket-1' });
      const user2 = createUser({ userId: 'user-2', socketId: 'socket-2', name: 'Bob' });

      tracker.addViewer('page-1', 'drive-1', user1);
      tracker.addViewer('page-1', 'drive-1', user2);
      const viewers = tracker.removeViewer('socket-1', 'page-1');

      expect(viewers).toHaveLength(1);
      expect(viewers![0].userId).toBe('user-2');
    });

    it('given the last viewer leaving, should return empty array', () => {
      const user = createUser();

      tracker.addViewer('page-1', 'drive-1', user);
      const viewers = tracker.removeViewer('socket-1', 'page-1');

      expect(viewers).toEqual([]);
    });

    it('given removing a viewer from a page they never joined, should return empty', () => {
      const viewers = tracker.removeViewer('nonexistent', 'page-1');

      expect(viewers).toEqual([]);
    });
  });

  describe('removeSocket', () => {
    it('given a socket disconnect, should remove from all pages and return affected pages', () => {
      const user = createUser();

      tracker.addViewer('page-1', 'drive-1', user);
      tracker.addViewer('page-2', 'drive-2', { ...user, socketId: 'socket-1' });

      const affected = tracker.removeSocket('socket-1');

      expect(affected).toHaveLength(2);
      expect(affected.find(p => p.pageId === 'page-1')!.viewers).toEqual([]);
      expect(affected.find(p => p.pageId === 'page-2')!.viewers).toEqual([]);
    });

    it('given other viewers remain, should include them in the affected page data', () => {
      const user1 = createUser({ userId: 'user-1', socketId: 'socket-1' });
      const user2 = createUser({ userId: 'user-2', socketId: 'socket-2', name: 'Bob' });

      tracker.addViewer('page-1', 'drive-1', user1);
      tracker.addViewer('page-1', 'drive-1', user2);

      const affected = tracker.removeSocket('socket-1');

      expect(affected).toHaveLength(1);
      expect(affected[0].viewers).toHaveLength(1);
      expect(affected[0].viewers[0].userId).toBe('user-2');
    });

    it('given a socket with no presence, should return empty array', () => {
      const affected = tracker.removeSocket('nonexistent');

      expect(affected).toEqual([]);
    });

    it('given disconnect, should include driveId in affected page info', () => {
      const user = createUser();

      tracker.addViewer('page-1', 'drive-42', user);
      const affected = tracker.removeSocket('socket-1');

      expect(affected[0].driveId).toBe('drive-42');
    });
  });

  describe('getViewers', () => {
    it('given a page with no viewers, should return empty array', () => {
      expect(tracker.getViewers('nonexistent')).toEqual([]);
    });

    it('given a page with viewers, should return all of them', () => {
      const user1 = createUser({ userId: 'user-1', socketId: 'socket-1' });
      const user2 = createUser({ userId: 'user-2', socketId: 'socket-2', name: 'Bob' });

      tracker.addViewer('page-1', 'drive-1', user1);
      tracker.addViewer('page-1', 'drive-1', user2);

      expect(tracker.getViewers('page-1')).toHaveLength(2);
    });
  });

  describe('getUniqueViewers', () => {
    it('given a user with multiple sockets on the same page, should deduplicate by userId', () => {
      const socket1 = createUser({ userId: 'user-1', socketId: 'socket-1' });
      const socket2 = createUser({ userId: 'user-1', socketId: 'socket-2' });

      tracker.addViewer('page-1', 'drive-1', socket1);
      tracker.addViewer('page-1', 'drive-1', socket2);

      const unique = tracker.getUniqueViewers('page-1');
      expect(unique).toHaveLength(1);
      expect(unique[0].userId).toBe('user-1');
    });

    it('given different users, should return all of them', () => {
      const user1 = createUser({ userId: 'user-1', socketId: 'socket-1' });
      const user2 = createUser({ userId: 'user-2', socketId: 'socket-2', name: 'Bob' });

      tracker.addViewer('page-1', 'drive-1', user1);
      tracker.addViewer('page-1', 'drive-1', user2);

      expect(tracker.getUniqueViewers('page-1')).toHaveLength(2);
    });
  });

  describe('getDriveId', () => {
    it('given a tracked page, should return its cached driveId', () => {
      const user = createUser();

      tracker.addViewer('page-1', 'drive-42', user);

      expect(tracker.getDriveId('page-1')).toBe('drive-42');
    });

    it('given an untracked page, should return undefined', () => {
      expect(tracker.getDriveId('nonexistent')).toBeUndefined();
    });

    it('given all viewers leave, should clean up the driveId cache', () => {
      const user = createUser();

      tracker.addViewer('page-1', 'drive-1', user);
      tracker.removeSocket('socket-1');

      expect(tracker.getDriveId('page-1')).toBeUndefined();
    });
  });

  describe('getPagesForSocket', () => {
    it('given a socket viewing multiple pages, should return all page ids', () => {
      const user = createUser();

      tracker.addViewer('page-1', 'drive-1', user);
      tracker.addViewer('page-2', 'drive-1', user);

      const pages = tracker.getPagesForSocket('socket-1');
      expect(pages).toContain('page-1');
      expect(pages).toContain('page-2');
    });

    it('given an unknown socket, should return empty array', () => {
      expect(tracker.getPagesForSocket('nonexistent')).toEqual([]);
    });
  });
});
