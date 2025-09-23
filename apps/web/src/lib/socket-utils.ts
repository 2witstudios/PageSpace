/**
 * Socket.IO utilities for broadcasting page tree and drive events
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/broadcast-auth';
import { loggers } from '@pagespace/lib/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';

export type PageOperation = 'created' | 'updated' | 'moved' | 'deleted' | 'restored' | 'trashed' | 'content-updated';
export type DriveOperation = 'created' | 'updated' | 'deleted';
export type TaskOperation = 'task_list_created' | 'task_added' | 'task_updated' | 'task_completed';
export type UsageOperation = 'updated';

export interface PageEventPayload {
  driveId: string;
  pageId: string;
  parentId?: string | null;
  operation: PageOperation;
  title?: string;
  type?: string;
}

export interface DriveEventPayload {
  driveId: string;
  operation: DriveOperation;
  name?: string;
  slug?: string;
}

export interface TaskEventPayload {
  type: TaskOperation;
  taskId?: string;
  taskListId?: string;
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
const verboseRealtimeLogging = process.env.NODE_ENV !== 'production';

/**
 * Broadcasts a page event to the realtime server
 * @param payload - The event payload to broadcast
 */
export async function broadcastPageEvent(payload: PageEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  if (!process.env.INTERNAL_REALTIME_URL) {
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

    await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
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
  if (!process.env.INTERNAL_REALTIME_URL) {
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

    await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
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
 * Broadcasts a task event to the realtime server
 * @param payload - The task event payload to broadcast
 */
export async function broadcastTaskEvent(payload: TaskEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  if (!process.env.INTERNAL_REALTIME_URL) {
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

    await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
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
  if (!process.env.INTERNAL_REALTIME_URL) {
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

    await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
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