import { parseTabPath, isDriveScopedPath } from '@/lib/tabs/tab-title';
import type { DriveEntry } from './resolveLocationContext';

export type ContextRefRouteType = 'page' | 'channel' | 'drive' | 'dm' | 'other';

export interface ContextRef {
  routeType: ContextRefRouteType;
  pageId?: string;
  driveId?: string;
  dmConversationId?: string;
}

/**
 * Synchronous replacement for the send-time client fetch this epic removes:
 * where `resolveLocationContext` hit `/api/pages/:id` + `/breadcrumbs` on every
 * send (0.5-3s, uncached by design), this only parses the CURRENT pathname —
 * already available, no network — into a reference the server resolves (and,
 * critically, permission-checks) at request time. The server is the only
 * source of truth for what a pageId/driveId actually resolves to; this never
 * claims otherwise.
 *
 * `driveId` is dropped when it isn't in the caller's own known `drives` list —
 * a defense-in-depth trim, not a permission check (the server denies access to
 * anything the caller can't view regardless of what ships in the ref).
 *
 * Pure — no I/O, no side effects.
 */
export const buildContextRef = (pathname: string, drives: DriveEntry[]): ContextRef => {
  const parsed = parseTabPath(pathname);
  const knownDriveId = (id: string | undefined): string | undefined =>
    id && drives.some((d) => d.id === id) ? id : undefined;

  switch (parsed.type) {
    case 'page':
      return { routeType: 'page', pageId: parsed.pageId, driveId: knownDriveId(parsed.driveId) };
    case 'channel':
      return { routeType: 'channel', pageId: parsed.pageId };
    case 'dm':
      return { routeType: 'dm', dmConversationId: parsed.conversationId };
    default:
      // Every drive-LEVEL route resolves as 'drive' — the bare
      // /dashboard/[driveId] and its sub-routes (tasks, members, settings, …)
      // alike. Previously only the bare route did and the rest fell through to
      // 'other', so the assistant lost the workspace the user was plainly
      // standing in and "put this here" landed in their Home drive instead.
      if (isDriveScopedPath(parsed)) {
        return { routeType: 'drive', driveId: knownDriveId(parsed.driveId) };
      }
      return { routeType: 'other' };
  }
};
