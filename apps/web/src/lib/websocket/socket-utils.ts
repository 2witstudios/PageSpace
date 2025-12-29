/**
 * Socket.IO utilities for broadcasting page tree and drive events
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/broadcast-auth';
import { browserLoggers } from '@pagespace/lib/logger-browser';
import { isNodeEnvironment } from '@pagespace/lib/utils/environment';
import { maskIdentifier } from '@/lib/logging/mask';

// Use browser-safe logger for all environments
// This prevents Node.js-specific API errors in browser contexts
const loggers = browserLoggers;

export type PageOperation = 'created' | 'updated' | 'moved' | 'deleted' | 'restored' | 'trashed' | 'content-updated';
export type DriveOperation = 'created' | 'updated' | 'deleted';
export type DriveMemberOperation = 'member_added' | 'member_role_changed' | 'member_removed';
export type TaskOperation = 'task_list_created' | 'task_added' | 'task_updated' | 'task_completed' | 'task_deleted' | 'tasks_reordered';
export type UsageOperation = 'updated';
export type ActivityOperation = 'logged';

export interface ActivityEventPayload {
  activityId: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  driveId: string | null;
  pageId: string | null;
  userId: string;
  timestamp: string;
}

export interface PageEventPayload {
  driveId: string;
  pageId: string;
  parentId?: string | null;
  operation: PageOperation;
  title?: string;
  type?: string;
  socketId?: string; // Socket ID of the user who triggered this event (to prevent self-refetch)
}

export interface DriveEventPayload {
  driveId: string;
  operation: DriveOperation;
  name?: string;
  slug?: string;
}

export interface DriveMemberEventPayload {
  driveId: string;
  userId: string; // The affected user
  operation: DriveMemberOperation;
  role?: 'OWNER' | 'ADMIN' | 'MEMBER';
  driveName?: string;
}

export interface TaskEventPayload {
  type: TaskOperation;
  taskId?: string;
  taskListId?: string;
  pageId?: string;
  userId: string;
  data: {
    [key: string]: unknown;
  };
}

export interface UsageEventPayload {
  userId: string;
  operation: UsageOperation;
  subscriptionTier: 'free' | 'pro' | 'business';
  standard: {
    current: number;
    limit: number;
    remaining: number;
  };
  pro: {
    current: number;
    limit: number;
    remaining: number;
  };
}

const realtimeLogger = loggers.realtime.child({ module: 'socket-utils' });

// Safely access environment variables
const getEnvVar = (name: string, fallback = '') => {
  if (isNodeEnvironment()) {
    return process.env[name] || fallback;
  }
  return fallback;
};

const verboseRealtimeLogging = getEnvVar('NODE_ENV') !== 'production';

/**
 * Broadcasts a page event to the realtime server
 * @param payload - The event payload to broadcast
 */
export async function broadcastPageEvent(payload: PageEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping page event broadcast', {
      event: 'page',
      channel: `drive:${maskIdentifier(payload.driveId)}`
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: `drive:${payload.driveId}`,
      event: `page:${payload.operation}`,
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
    });
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    realtimeLogger.error(
      'Failed to broadcast page event',
      error instanceof Error ? error : undefined,
      {
        event: 'page',
        channel: `drive:${maskIdentifier(payload.driveId)}`
      }
    );
  }
}

/**
 * Broadcasts a drive event to the realtime server
 * @param payload - The event payload to broadcast
 */
export async function broadcastDriveEvent(payload: DriveEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping drive event broadcast', {
      event: 'drive'
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: 'global:drives',
      event: `drive:${payload.operation}`,
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
    });
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    realtimeLogger.error(
      'Failed to broadcast drive event',
      error instanceof Error ? error : undefined,
      {
        event: 'drive'
      }
    );
  }
}

/**
 * Broadcasts a drive member event to the realtime server
 * Sent to user-specific channel so only affected user receives it
 * @param payload - The event payload to broadcast
 */
export async function broadcastDriveMemberEvent(payload: DriveMemberEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping member event broadcast', {
      event: 'drive_member',
      userId: maskIdentifier(payload.userId)
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: `user:${payload.userId}:drives`,
      event: `drive:${payload.operation}`,
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
    });

    if (verboseRealtimeLogging) {
      realtimeLogger.debug('Drive member event broadcasted', {
        operation: payload.operation,
        userId: maskIdentifier(payload.userId),
        driveId: maskIdentifier(payload.driveId)
      });
    }
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    realtimeLogger.error(
      'Failed to broadcast drive member event',
      error instanceof Error ? error : undefined,
      {
        event: 'drive_member',
        operation: payload.operation
      }
    );
  }
}

/**
 * Helper to create a page event payload
 */
export function createPageEventPayload(
  driveId: string,
  pageId: string,
  operation: PageOperation,
  options: {
    parentId?: string | null;
    title?: string;
    type?: string;
    socketId?: string;
  } = {}
): PageEventPayload {
  return {
    driveId,
    pageId,
    operation,
    ...options,
  };
}

/**
 * Helper to create a drive event payload
 */
export function createDriveEventPayload(
  driveId: string,
  operation: DriveOperation,
  options: {
    name?: string;
    slug?: string;
  } = {}
): DriveEventPayload {
  return {
    driveId,
    operation,
    ...options,
  };
}

/**
 * Helper to create a drive member event payload
 */
export function createDriveMemberEventPayload(
  driveId: string,
  userId: string,
  operation: DriveMemberOperation,
  options: {
    role?: 'OWNER' | 'ADMIN' | 'MEMBER';
    driveName?: string;
  } = {}
): DriveMemberEventPayload {
  return {
    driveId,
    userId,
    operation,
    ...options,
  };
}

/**
 * Broadcasts a task event to the realtime server
 * @param payload - The task event payload to broadcast
 */
export async function broadcastTaskEvent(payload: TaskEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping task event broadcast', {
      event: 'task'
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: `user:${payload.userId}:tasks`,
      event: `task:${payload.type}`,
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
    });
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    realtimeLogger.error(
      'Failed to broadcast task event',
      error instanceof Error ? error : undefined,
      {
        event: 'task',
        channel: `user:${maskIdentifier(payload.userId)}:tasks`
      }
    );
  }
}

/**
 * Broadcasts a usage event to the realtime server
 * @param payload - The usage event payload to broadcast
 */
export async function broadcastUsageEvent(payload: UsageEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping usage event broadcast', {
      event: 'usage'
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: `notifications:${payload.userId}`,
      event: `usage:${payload.operation}`,
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
    });

    if (verboseRealtimeLogging) {
      realtimeLogger.debug('Usage event broadcasted', {
        userId: maskIdentifier(payload.userId),
        operation: payload.operation,
        standard: `${payload.standard.current}/${payload.standard.limit}`,
        pro: `${payload.pro.current}/${payload.pro.limit}`
      });
    }
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    realtimeLogger.error(
      'Failed to broadcast usage event',
      error instanceof Error ? error : undefined,
      {
        event: 'usage',
        channel: `notifications:${maskIdentifier(payload.userId)}`
      }
    );
  }
}

// ============================================================================
// Activity Events (with debouncing)
// ============================================================================

// In-memory debounce state per context
const pendingActivityBroadcasts = new Map<string, NodeJS.Timeout>();
const ACTIVITY_DEBOUNCE_MS = 500;

/**
 * Broadcasts an activity event to the realtime server with debouncing.
 * Events are debounced per context (drive or page) to prevent event storms.
 * @param payload - The activity event payload to broadcast
 */
export async function broadcastActivityEvent(payload: ActivityEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    return;
  }

  // Determine contexts to broadcast to
  const contexts: { channelId: string; key: string }[] = [];
  if (payload.driveId) {
    contexts.push({
      channelId: `activity:drive:${payload.driveId}`,
      key: `drive:${payload.driveId}`,
    });
  }
  if (payload.pageId) {
    contexts.push({
      channelId: `activity:page:${payload.pageId}`,
      key: `page:${payload.pageId}`,
    });
  }

  // Debounce broadcasts per context
  for (const { channelId, key } of contexts) {
    // Clear existing timeout for this context
    const existing = pendingActivityBroadcasts.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new timeout
    const timeout = setTimeout(async () => {
      pendingActivityBroadcasts.delete(key);

      try {
        const requestBody = JSON.stringify({
          channelId,
          event: 'activity:logged',
          payload,
        });

        await fetch(`${realtimeUrl}/api/broadcast`, {
          method: 'POST',
          headers: createSignedBroadcastHeaders(requestBody),
          body: requestBody,
        });

        if (verboseRealtimeLogging) {
          realtimeLogger.debug('Activity event broadcasted', {
            channelId,
            operation: payload.operation,
            resourceType: payload.resourceType,
          });
        }
      } catch (error) {
        // Log error but don't throw - broadcasting failures shouldn't break operations
        realtimeLogger.error(
          'Failed to broadcast activity event',
          error instanceof Error ? error : undefined,
          {
            event: 'activity',
            channel: channelId,
          }
        );
      }
    }, ACTIVITY_DEBOUNCE_MS);

    pendingActivityBroadcasts.set(key, timeout);
  }
}