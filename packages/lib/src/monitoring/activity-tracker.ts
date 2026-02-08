/**
 * Lightweight Activity Tracker
 * Fire-and-forget async tracking with zero performance impact
 */

import { writeUserActivity } from '../logging/logger-database';
import { loggers } from '../logging/logger-config';
import { sessionService } from '../auth/session-service';

/**
 * Track user activity - fire and forget, never blocks
 */
export async function trackActivity(
  userId: string | undefined,
  action: string,
  data?: {
    resource?: string;
    resourceId?: string;
    driveId?: string;
    pageId?: string;
    sessionId?: string;
    ip?: string;
    userAgent?: string;
    metadata?: any;
  }
): Promise<void> {
  // Don't track if no user
  if (!userId) return;

  // Fire and forget - don't await
  writeUserActivity({
    userId,
    action,
    resource: data?.resource,
    resourceId: data?.resourceId,
    driveId: data?.driveId,
    pageId: data?.pageId,
    sessionId: data?.sessionId,
    ip: data?.ip,
    userAgent: data?.userAgent,
    metadata: data?.metadata,
  }).catch((error) => {
    // Log error but don't throw - never impact user experience
    loggers.api.debug('Activity tracking failed', { error: (error as Error).message, action });
  });
}

/**
 * Track page operations
 */
export function trackPageOperation(
  userId: string | undefined,
  operation: 'create' | 'read' | 'update' | 'delete' | 'share' | 'restore' | 'trash',
  pageId: string,
  metadata?: any
): void {
  trackActivity(userId, `page_${operation}`, {
    resource: 'page',
    resourceId: pageId,
    pageId,
    metadata
  });
}

/**
 * Track drive operations
 */
export function trackDriveOperation(
  userId: string | undefined,
  operation: 'create' | 'access' | 'update' | 'delete' | 'invite_member' | 'remove_member',
  driveId: string,
  metadata?: any
): void {
  trackActivity(userId, `drive_${operation}`, {
    resource: 'drive',
    resourceId: driveId,
    driveId,
    metadata
  });
}

/**
 * Track feature usage
 */
export function trackFeature(
  userId: string | undefined,
  feature: string,
  metadata?: any
): void {
  trackActivity(userId, `feature_${feature}`, {
    resource: 'feature',
    resourceId: feature,
    metadata
  });
}

/**
 * Track authentication events
 */
export function trackAuthEvent(
  userId: string | undefined,
  event: 'login' | 'logout' | 'signup' | 'refresh' | 'failed_login' | 'failed_oauth' | 'email_verified',
  metadata?: any
): void {
  trackActivity(userId || 'anonymous', `auth_${event}`, {
    resource: 'auth',
    metadata
  });
}

/**
 * Track errors that affect users
 */
export function trackError(
  userId: string | undefined,
  errorType: string,
  errorMessage: string,
  context?: any
): void {
  trackActivity(userId, 'error', {
    resource: 'error',
    metadata: {
      type: errorType,
      message: errorMessage.substring(0, 200), // Limit message length
      context
    }
  });
}

/**
 * Helper to extract user ID from request cookies (server-side)
 */
export async function getUserIdFromRequest(request: Request): Promise<string | undefined> {
  try {
    const cookieHeader = request.headers.get('cookie');
    if (!cookieHeader) return undefined;

    // Simple cookie parsing for session token
    const cookies = Object.fromEntries(
      cookieHeader.split('; ').map(c => c.split('='))
    );

    const token = cookies.session;
    if (!token) return undefined;

    const sessionClaims = await sessionService.validateSession(token);
    return sessionClaims?.userId;
  } catch {
    return undefined;
  }
}