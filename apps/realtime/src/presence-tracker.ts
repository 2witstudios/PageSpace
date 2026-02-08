/**
 * Presence Tracker
 * Tracks which users are currently viewing which pages.
 * Maintains user metadata for display (name, avatarUrl) and provides
 * deterministic viewer lists per page.
 *
 * Designed to work alongside SocketRegistry - SocketRegistry handles
 * room membership and permission revocation, PresenceTracker handles
 * "who is viewing what" with display metadata.
 */

import type { PresenceViewer } from '@pagespace/lib/client-safe';

// Re-export for convenience
export type { PresenceViewer };

export interface PagePresenceInfo {
  pageId: string;
  driveId: string;
  viewers: PresenceViewer[];
}

export class PresenceTracker {
  // pageId → Map<socketId, PresenceViewer>
  private pageViewers = new Map<string, Map<string, PresenceViewer>>();

  // socketId → Set<pageId> (for cleanup on disconnect)
  private socketToPages = new Map<string, Set<string>>();

  // pageId → driveId (cached for broadcasting to drive rooms)
  private pageToDrive = new Map<string, string>();

  /**
   * Add a user as a viewer of a page.
   * Returns the updated viewer list for the page.
   */
  addViewer(
    pageId: string,
    driveId: string,
    user: PresenceViewer
  ): PresenceViewer[] {
    // Track page → drive mapping
    this.pageToDrive.set(pageId, driveId);

    // Add to page viewers
    if (!this.pageViewers.has(pageId)) {
      this.pageViewers.set(pageId, new Map());
    }
    this.pageViewers.get(pageId)!.set(user.socketId, user);

    // Track socket → pages for cleanup
    if (!this.socketToPages.has(user.socketId)) {
      this.socketToPages.set(user.socketId, new Set());
    }
    this.socketToPages.get(user.socketId)!.add(pageId);

    return this.getViewers(pageId);
  }

  /**
   * Remove a user from viewing a page (by socketId).
   * Returns the updated viewer list for the page.
   */
  removeViewer(socketId: string, pageId: string): PresenceViewer[] {
    const viewers = this.pageViewers.get(pageId);
    if (viewers) {
      viewers.delete(socketId);
      if (viewers.size === 0) {
        this.pageViewers.delete(pageId);
        this.pageToDrive.delete(pageId);
      }
    }

    const pages = this.socketToPages.get(socketId);
    if (pages) {
      pages.delete(pageId);
      if (pages.size === 0) {
        this.socketToPages.delete(socketId);
      }
    }

    return this.getViewers(pageId);
  }

  /**
   * Remove a socket from all pages it's viewing.
   * Returns a list of affected pages with their updated viewer lists.
   */
  removeSocket(socketId: string): PagePresenceInfo[] {
    const pages = this.socketToPages.get(socketId);
    if (!pages || pages.size === 0) {
      this.socketToPages.delete(socketId);
      return [];
    }

    const affected: PagePresenceInfo[] = [];

    for (const pageId of pages) {
      const viewers = this.pageViewers.get(pageId);
      if (viewers) {
        viewers.delete(socketId);
        const driveId = this.pageToDrive.get(pageId) || '';

        if (viewers.size === 0) {
          this.pageViewers.delete(pageId);
          this.pageToDrive.delete(pageId);
          // Still report the page so clients know it now has zero viewers
          affected.push({ pageId, driveId, viewers: [] });
        } else {
          affected.push({
            pageId,
            driveId,
            viewers: Array.from(viewers.values()),
          });
        }
      }
    }

    this.socketToPages.delete(socketId);
    return affected;
  }

  /**
   * Get all current viewers of a page.
   */
  getViewers(pageId: string): PresenceViewer[] {
    const viewers = this.pageViewers.get(pageId);
    if (!viewers) return [];
    return Array.from(viewers.values());
  }

  /**
   * Get the driveId for a page (from cache).
   */
  getDriveId(pageId: string): string | undefined {
    return this.pageToDrive.get(pageId);
  }

  /**
   * Get all pages a socket is currently viewing.
   */
  getPagesForSocket(socketId: string): string[] {
    const pages = this.socketToPages.get(socketId);
    return pages ? Array.from(pages) : [];
  }

  /**
   * Deduplicate viewers by userId (a user may have multiple tabs/sockets).
   * Returns one entry per user, preferring the most recent socket.
   */
  getUniqueViewers(pageId: string): PresenceViewer[] {
    const viewers = this.getViewers(pageId);
    const byUser = new Map<string, PresenceViewer>();
    for (const viewer of viewers) {
      byUser.set(viewer.userId, viewer);
    }
    return Array.from(byUser.values());
  }
}

// Singleton instance
export const presenceTracker = new PresenceTracker();
