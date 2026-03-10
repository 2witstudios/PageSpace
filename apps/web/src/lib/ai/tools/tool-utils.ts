/**
 * @module lib/ai/tools/tool-utils
 * @description Shared utilities for AI tool implementations
 *
 * This module provides common patterns extracted from AI tools to:
 * - Reduce code duplication
 * - Standardize authentication handling
 * - Provide consistent response builders
 * - Centralize permission checks
 */

import { getActorInfo, getUserDriveAccess, canUserEditPage, logPageActivity } from '@pagespace/lib/server';
import { isUserDriveMember } from '@pagespace/lib';
import { type ToolExecutionContext } from '../core';
import { getTimezoneOffsetMinutes, isNaiveISODatetime, parseNaiveDatetimeInTimezone } from '../core/timestamp-utils';
import * as chrono from 'chrono-node';

// ============================================================================
// Types
// ============================================================================

/**
 * AI activity context for logging AI-generated actions
 */
export interface AiActivityContext {
  actorEmail: string;
  actorDisplayName: string;
  isAiGenerated: true;
  aiProvider: string;
  aiModel: string;
  aiConversationId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Standard tool response structure
 */
export interface ToolResponse<T = unknown> {
  success: boolean;
  summary: string;
  stats?: Record<string, number | string>;
  nextSteps?: string[];
  data?: T;
  error?: string;
}

/**
 * Options for successResponse builder
 */
export interface SuccessResponseOptions {
  stats?: Record<string, number | string>;
  nextSteps?: string[];
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Extract authenticated user ID from tool execution context
 * @throws Error if user is not authenticated
 */
export function getAuthenticatedUserId(context: unknown): string {
  const userId = (context as ToolExecutionContext)?.userId;
  if (!userId) {
    throw new Error('User authentication required');
  }
  return userId;
}

// ============================================================================
// AI Context Building
// ============================================================================

/**
 * Build AI attribution context with actor info for activity logging
 * Used when logging AI-generated actions to the activity log
 */
export async function buildAiContext(context: ToolExecutionContext): Promise<AiActivityContext> {
  const actorInfo = await getActorInfo(context.userId);

  // Build chain metadata (Tier 1) for agent tracking
  const chainMetadata: Record<string, unknown> = {};
  if (context.parentAgentId) chainMetadata.parentAgentId = context.parentAgentId;
  if (context.parentConversationId) chainMetadata.parentConversationId = context.parentConversationId;
  if (context.agentChain?.length) chainMetadata.agentChain = context.agentChain;
  if (context.requestOrigin) chainMetadata.requestOrigin = context.requestOrigin;

  return {
    ...actorInfo,
    isAiGenerated: true,
    aiProvider: context.aiProvider ?? 'unknown',
    aiModel: context.aiModel ?? 'unknown',
    aiConversationId: context.conversationId ?? '',
    metadata: Object.keys(chainMetadata).length > 0 ? chainMetadata : undefined,
  };
}

// ============================================================================
// Response Builders
// ============================================================================

/**
 * Create a standardized success response
 */
export function successResponse<T>(
  data: T,
  summary: string,
  options?: SuccessResponseOptions
): ToolResponse<T> {
  return {
    success: true,
    summary,
    data,
    ...(options?.stats && { stats: options.stats }),
    ...(options?.nextSteps && { nextSteps: options.nextSteps }),
  };
}

/**
 * Create a standardized error response
 */
export function errorResponse(
  error: string,
  details?: Record<string, unknown>
): ToolResponse {
  return {
    success: false,
    summary: error,
    error,
    ...(details && { ...details }),
  };
}

/**
 * Create a success response with the common pattern used by most tools
 */
export function toolSuccess<T extends Record<string, unknown>>(
  data: T,
  options: {
    summary: string;
    stats?: Record<string, number | string>;
    nextSteps?: string[];
  }
): ToolResponse<T> {
  return {
    success: true,
    summary: options.summary,
    data,
    ...(options.stats && { stats: options.stats }),
    ...(options.nextSteps && { nextSteps: options.nextSteps }),
  };
}

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Check if user has access to a drive
 * @throws Error if user doesn't have access
 */
export async function checkDriveAccess(userId: string, driveId: string): Promise<void> {
  const hasAccess = await getUserDriveAccess(userId, driveId);
  if (!hasAccess) {
    throw new Error(`You don't have access to this workspace`);
  }
}

/**
 * Check if user can edit a page
 * @throws Error if user doesn't have edit access
 */
export async function checkPageEditAccess(userId: string, pageId: string): Promise<void> {
  const hasAccess = await canUserEditPage(userId, pageId);
  if (!hasAccess) {
    throw new Error('You do not have permission to edit this page');
  }
}

/**
 * Verify drive membership (lighter weight check)
 * @returns true if user is a member, false otherwise
 */
export async function verifyDriveMembership(userId: string, driveId: string): Promise<boolean> {
  return isUserDriveMember(userId, driveId);
}

// ============================================================================
// Activity Logging Helpers
// ============================================================================

/**
 * Non-blocking activity logging with AI context (fire-and-forget)
 * Logs the activity without awaiting the result
 */
export function logPageActivityAsync(
  userId: string,
  action: Parameters<typeof logPageActivity>[1],
  page: { id: string; title: string; driveId: string; content?: string },
  context: ToolExecutionContext,
  options?: {
    metadata?: Record<string, unknown>;
    previousValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    updatedFields?: string[];
    contentRef?: string;
    contentSize?: number;
  }
): void {
  // Fire-and-forget logging
  buildAiContext(context)
    .then(aiContext => {
      logPageActivity(userId, action, page, {
        ...aiContext,
        ...options,
        metadata: {
          ...aiContext.metadata,
          ...options?.metadata,
        },
      });
    })
    .catch(err => {
      console.error('Failed to log page activity:', err);
    });
}

// ============================================================================
// Time Helpers (from activity-tools)
// ============================================================================

/**
 * Get the start timestamp for a given time window
 */
export function getTimeWindowStart(window: string, lastVisitTime?: Date): Date {
  const now = new Date();

  switch (window) {
    case '1h':
      return new Date(now.getTime() - 60 * 60 * 1000);
    case '24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case 'last_visit':
      return lastVisitTime || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    default:
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

// ============================================================================
// Delta Helpers (from activity-tools)
// ============================================================================

/**
 * Create a compact delta from previousValues/newValues for activity logs
 * Optimized for token efficiency in AI context
 */
export function createCompactDelta(
  updatedFields: string[] | null,
  prev: Record<string, unknown> | null,
  next: Record<string, unknown> | null
): Record<string, { from?: unknown; to?: unknown; len?: { from: number; to: number } }> | undefined {
  if (!updatedFields || updatedFields.length === 0) return undefined;

  const delta: Record<string, { from?: unknown; to?: unknown; len?: { from: number; to: number } }> = {};

  for (const field of updatedFields) {
    const fromVal = prev?.[field];
    const toVal = next?.[field];

    // For content/text fields, just show length change to save tokens
    if (field === 'content' || field === 'systemPrompt' || field === 'drivePrompt') {
      const fromLen = typeof fromVal === 'string' ? fromVal.length : 0;
      const toLen = typeof toVal === 'string' ? toVal.length : 0;
      if (fromLen !== toLen) {
        delta[field] = { len: { from: fromLen, to: toLen } };
      }
    } else if (field === 'title') {
      // Title changes are small and meaningful - include full values
      delta[field] = { from: fromVal, to: toVal };
    } else if (typeof fromVal === 'boolean' || typeof toVal === 'boolean') {
      // Booleans are small
      delta[field] = { from: fromVal, to: toVal };
    } else if (typeof fromVal === 'number' || typeof toVal === 'number') {
      // Numbers are small
      delta[field] = { from: fromVal, to: toVal };
    } else {
      // For other fields, just note they changed
      delta[field] = {};
    }
  }

  return Object.keys(delta).length > 0 ? delta : undefined;
}

// ============================================================================
// Calendar Helpers
// ============================================================================

/**
 * Parse a date string that can be either ISO 8601 or natural language.
 * Uses chrono-node for natural language parsing with timezone awareness.
 * @param input - Date string (ISO 8601 or natural language)
 * @param referenceDate - Reference date for relative parsing (e.g., "tomorrow")
 * @param timezone - IANA timezone string for interpreting times (e.g., "America/New_York")
 */
export function parseDateTime(input: string, referenceDate?: Date, timezone?: string): Date {
  // Try ISO 8601 first
  const isoDate = new Date(input);
  if (!isNaN(isoDate.getTime())) {
    // If the input is a naive ISO datetime (no Z or offset) and a timezone is provided,
    // interpret the time in the specified timezone instead of treating as UTC/server-local.
    // E.g., "2026-02-19T19:00:00" with timezone "America/Chicago" → 7pm Central, not 7pm UTC.
    if (timezone && isNaiveISODatetime(input)) {
      return parseNaiveDatetimeInTimezone(input, timezone);
    }
    return isoDate;
  }

  // Build timezone-aware reference for chrono-node so that
  // natural language like "tomorrow at 3pm" is interpreted in the user's timezone
  const ref: { instant: Date; timezone?: number } = {
    instant: referenceDate ?? new Date(),
  };
  if (timezone) {
    ref.timezone = getTimezoneOffsetMinutes(timezone, ref.instant);
  }

  // Try natural language parsing with chrono-node
  const parsed = chrono.parseDate(input, ref, { forwardDate: true });
  if (!parsed) {
    throw new Error(`Could not parse date: "${input}". Use ISO 8601 format (e.g., "2024-01-15T10:00:00Z") or natural language (e.g., "tomorrow at 3pm", "next Monday 10am").`);
  }

  return parsed;
}

/**
 * Calendar event type for permission checking
 */
export type CalendarEventType = {
  createdById: string;
  [key: string]: unknown;
};

/**
 * Check if user can edit a calendar event
 * @returns { canEdit: boolean, reason?: string }
 */
export function canEditCalendarEvent(
  userId: string,
  event: CalendarEventType
): { canEdit: boolean; reason?: string } {
  if (event.createdById !== userId) {
    return {
      canEdit: false,
      reason: 'Only the event creator can edit this event.',
    };
  }
  return { canEdit: true };
}
