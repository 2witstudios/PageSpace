/**
 * Per-Event Authorization
 *
 * Zero-trust principle: Room membership proves you HAD access when you joined.
 * For sensitive operations (writes), re-verify permission before allowing.
 *
 * This prevents the "revoked but still in room" attack window where a user
 * might have been kicked from the permission system but their socket
 * hasn't been kicked from the room yet.
 *
 * Stale-window analysis after bypassCache fix:
 * - Write operations (per-event auth): 0s — always hits DB directly
 * - Room joins: up to 60s (kick handler provides immediate eviction)
 * - API routes: up to 60s (read operations, acceptable risk)
 */

import { getUserAccessLevel } from '@pagespace/lib/permissions-cached';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * Events that require re-authorization before processing.
 * These are write operations that could cause data changes.
 */
export type SensitiveEventType =
  | 'document_update'
  | 'page_content_change'
  | 'page_delete'
  | 'page_move'
  | 'file_upload'
  | 'comment_create'
  | 'comment_delete'
  | 'task_create'
  | 'task_update'
  | 'task_delete';

/**
 * Events that are read-only and don't require re-authorization.
 * Room membership is sufficient for these.
 */
export type ReadOnlyEventType =
  | 'cursor_move'
  | 'presence_update'
  | 'typing_indicator'
  | 'selection_change'
  | 'activity_logged';

const SENSITIVE_EVENTS = new Set<string>([
  'document_update',
  'page_content_change',
  'page_delete',
  'page_move',
  'file_upload',
  'comment_create',
  'comment_delete',
  'task_create',
  'task_update',
  'task_delete',
]);

/**
 * Check if an event type requires re-authorization
 */
export function isSensitiveEvent(eventType: string): boolean {
  return SENSITIVE_EVENTS.has(eventType);
}

interface ReauthorizeParams {
  eventType: string;
  roomType: 'page' | 'drive' | 'activity' | 'dm' | 'notification';
  resourceId: string;
}

/**
 * Determine if an event should trigger re-authorization
 */
export function shouldReauthorize(params: ReauthorizeParams): boolean {
  const { eventType, roomType } = params;

  // Activity rooms are read-only, no re-auth needed
  if (roomType === 'activity') {
    return false;
  }

  // Notification rooms are user-specific, no re-auth needed
  if (roomType === 'notification') {
    return false;
  }

  // Check if this is a sensitive event
  return isSensitiveEvent(eventType);
}

interface AuthCheckResult {
  authorized: boolean;
  reason?: string;
  accessLevel?: string | null;
}

/**
 * Re-check authorization for a sensitive event.
 * This goes directly to the permission system (cache or DB) to verify current access.
 *
 * @param userId - The user attempting the action
 * @param pageId - The page being accessed
 * @param requiredLevel - The minimum access level required ('view' | 'edit' | 'share' | 'delete')
 */
export async function reauthorizePageAccess(
  userId: string,
  pageId: string,
  requiredLevel: 'view' | 'edit' = 'edit'
): Promise<AuthCheckResult> {
  try {
    const accessLevel = await getUserAccessLevel(userId, pageId, { bypassCache: true });

    if (!accessLevel) {
      loggers.realtime.warn('Per-event auth: Access denied (no permission)', {
        userId,
        pageId,
        requiredLevel,
      });
      return {
        authorized: false,
        reason: 'No access to this page',
        accessLevel: null,
      };
    }

    // Check if access level is sufficient
    const hasRequiredAccess = requiredLevel === 'view'
      ? accessLevel.canView
      : accessLevel.canEdit;

    if (!hasRequiredAccess) {
      loggers.realtime.warn('Per-event auth: Access denied (insufficient level)', {
        userId,
        pageId,
        requiredLevel,
        actualLevel: accessLevel,
      });
      return {
        authorized: false,
        reason: `Requires ${requiredLevel} permission`,
        accessLevel: JSON.stringify(accessLevel),
      };
    }

    loggers.realtime.debug('Per-event auth: Access granted', {
      userId,
      pageId,
      requiredLevel,
    });

    return {
      authorized: true,
      accessLevel: JSON.stringify(accessLevel),
    };
  } catch (error) {
    loggers.realtime.error('Per-event auth: Error checking access', error as Error, {
      userId,
      pageId,
    });

    // Fail closed: deny access on error
    return {
      authorized: false,
      reason: 'Authorization check failed',
    };
  }
}
