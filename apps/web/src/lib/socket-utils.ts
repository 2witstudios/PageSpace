/**
 * Socket.IO utilities for broadcasting page tree and drive events
 */

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
  subscriptionTier: 'normal' | 'pro';
  normal: {
    current: number;
    limit: number;
    remaining: number;
  };
  extraThinking: {
    current: number;
    limit: number;
    remaining: number;
  };
}

/**
 * Broadcasts a page event to the realtime server
 * @param payload - The event payload to broadcast
 */
export async function broadcastPageEvent(payload: PageEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  if (!process.env.INTERNAL_REALTIME_URL) {
    console.warn('INTERNAL_REALTIME_URL not configured, skipping page event broadcast');
    return;
  }

  try {
    await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: `drive:${payload.driveId}`,
        event: `page:${payload.operation}`,
        payload,
      }),
    });
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    console.error('Failed to broadcast page event:', error);
  }
}

/**
 * Broadcasts a drive event to the realtime server
 * @param payload - The event payload to broadcast
 */
export async function broadcastDriveEvent(payload: DriveEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  if (!process.env.INTERNAL_REALTIME_URL) {
    console.warn('INTERNAL_REALTIME_URL not configured, skipping drive event broadcast');
    return;
  }

  try {
    await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: 'global:drives',
        event: `drive:${payload.operation}`,
        payload,
      }),
    });
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    console.error('Failed to broadcast drive event:', error);
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
    console.warn('INTERNAL_REALTIME_URL not configured, skipping task event broadcast');
    return;
  }

  try {
    await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: `user:${payload.userId}:tasks`,
        event: `task:${payload.type}`,
        payload,
      }),
    });
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    console.error('Failed to broadcast task event:', error);
  }
}

/**
 * Broadcasts a usage event to the realtime server
 * @param payload - The usage event payload to broadcast
 */
export async function broadcastUsageEvent(payload: UsageEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  if (!process.env.INTERNAL_REALTIME_URL) {
    console.warn('INTERNAL_REALTIME_URL not configured, skipping usage event broadcast');
    return;
  }

  try {
    await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: `notifications:${payload.userId}`,
        event: `usage:${payload.operation}`,
        payload,
      }),
    });

    console.log('🔔 Usage event broadcasted:', {
      userId: payload.userId,
      operation: payload.operation,
      normal: `${payload.normal.current}/${payload.normal.limit}`,
      extraThinking: `${payload.extraThinking.current}/${payload.extraThinking.limit}`
    });
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    console.error('Failed to broadcast usage event:', error);
  }
}