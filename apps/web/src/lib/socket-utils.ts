/**
 * Socket.IO utilities for broadcasting page tree and drive events
 */

export type PageOperation = 'created' | 'updated' | 'moved' | 'deleted' | 'restored' | 'trashed' | 'content-updated';
export type DriveOperation = 'created' | 'updated' | 'deleted';

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