/**
 * Utility function to create audit events
 *
 * This provides a type-safe, convenient API for logging actions across PageSpace.
 * Every meaningful action should create an audit event.
 */

import {
  db,
  auditEvents,
  auditActionType,
  auditEntityType,
} from '@pagespace/db';

type AuditActionType = typeof auditActionType.enumValues[number];
type AuditEntityType = typeof auditEntityType.enumValues[number];

export interface CreateAuditEventParams {
  // Required fields
  actionType: AuditActionType;
  entityType: AuditEntityType;
  entityId: string;

  // Actor (at least one should be provided)
  userId?: string;
  isAiAction?: boolean;
  aiOperationId?: string;

  // Scope
  driveId?: string;

  // Change tracking
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  changes?: Record<string, { before: any; after: any }>;

  // Context
  description?: string;
  reason?: string;
  metadata?: Record<string, any>;

  // Request context
  requestId?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;

  // Grouping
  operationId?: string;
  parentEventId?: string;
}

/**
 * Creates an audit event in the database
 *
 * @param params - Audit event parameters
 * @returns The created audit event
 *
 * @example
 * ```typescript
 * // User updates a page
 * await createAuditEvent({
 *   actionType: 'PAGE_UPDATE',
 *   entityType: 'PAGE',
 *   entityId: pageId,
 *   userId: userId,
 *   driveId: driveId,
 *   beforeState: { title: 'Old Title', content: 'Old content' },
 *   afterState: { title: 'New Title', content: 'New content' },
 *   changes: {
 *     title: { before: 'Old Title', after: 'New Title' }
 *   },
 *   description: 'Updated page title',
 *   reason: 'User edited the page'
 * });
 * ```
 *
 * @example
 * ```typescript
 * // AI generates content
 * await createAuditEvent({
 *   actionType: 'AI_GENERATE',
 *   entityType: 'PAGE',
 *   entityId: pageId,
 *   userId: userId,
 *   isAiAction: true,
 *   aiOperationId: operationId,
 *   driveId: driveId,
 *   afterState: { content: 'AI-generated content' },
 *   description: 'AI generated page content',
 *   reason: 'User requested AI content generation'
 * });
 * ```
 */
export async function createAuditEvent(params: CreateAuditEventParams) {
  const {
    actionType,
    entityType,
    entityId,
    userId,
    isAiAction = false,
    aiOperationId,
    driveId,
    beforeState,
    afterState,
    changes,
    description,
    reason,
    metadata,
    requestId,
    sessionId,
    ipAddress,
    userAgent,
    operationId,
    parentEventId,
  } = params;

  // Validation
  if (!userId && !isAiAction) {
    console.warn(
      'Audit event created without userId and isAiAction=false. This may indicate missing attribution.'
    );
  }

  if (isAiAction && !aiOperationId) {
    console.warn(
      'AI action audit event created without aiOperationId. AI attribution may be incomplete.'
    );
  }

  const [event] = await db
    .insert(auditEvents)
    .values({
      actionType,
      entityType,
      entityId,
      userId,
      isAiAction,
      aiOperationId,
      driveId,
      beforeState: beforeState || null,
      afterState: afterState || null,
      changes: changes || null,
      description,
      reason,
      metadata: metadata || null,
      requestId,
      sessionId,
      ipAddress,
      userAgent,
      operationId,
      parentEventId,
      createdAt: new Date(),
    })
    .returning();

  return event;
}

/**
 * Creates multiple audit events in a single transaction
 *
 * @param events - Array of audit event parameters
 * @returns Array of created audit events
 *
 * @example
 * ```typescript
 * // Log multiple related actions
 * await createBulkAuditEvents([
 *   {
 *     actionType: 'PAGE_MOVE',
 *     entityType: 'PAGE',
 *     entityId: page1Id,
 *     userId: userId,
 *     driveId: driveId,
 *     operationId: opId,
 *   },
 *   {
 *     actionType: 'PAGE_MOVE',
 *     entityType: 'PAGE',
 *     entityId: page2Id,
 *     userId: userId,
 *     driveId: driveId,
 *     operationId: opId,
 *   }
 * ]);
 * ```
 */
export async function createBulkAuditEvents(
  events: CreateAuditEventParams[]
) {
  const values = events.map((params) => ({
    actionType: params.actionType,
    entityType: params.entityType,
    entityId: params.entityId,
    userId: params.userId,
    isAiAction: params.isAiAction || false,
    aiOperationId: params.aiOperationId,
    driveId: params.driveId,
    beforeState: params.beforeState || null,
    afterState: params.afterState || null,
    changes: params.changes || null,
    description: params.description,
    reason: params.reason,
    metadata: params.metadata || null,
    requestId: params.requestId,
    sessionId: params.sessionId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    operationId: params.operationId,
    parentEventId: params.parentEventId,
    createdAt: new Date(),
  }));

  return await db.insert(auditEvents).values(values).returning();
}

/**
 * Computes changes object from before and after states
 *
 * @param before - Previous state
 * @param after - New state
 * @returns Changes object with before/after values for changed fields
 *
 * @example
 * ```typescript
 * const changes = computeChanges(
 *   { title: 'Old', content: 'Old content', position: 1 },
 *   { title: 'New', content: 'Old content', position: 2 }
 * );
 * // Result: {
 * //   title: { before: 'Old', after: 'New' },
 * //   position: { before: 1, after: 2 }
 * // }
 * ```
 */
export function computeChanges(
  before: Record<string, any>,
  after: Record<string, any>
): Record<string, { before: any; after: any }> {
  const changes: Record<string, { before: any; after: any }> = {};

  // Check all keys in 'after' state
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      changes[key] = {
        before: before[key],
        after: after[key],
      };
    }
  }

  // Check for removed keys (present in before but not in after)
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      changes[key] = {
        before: before[key],
        after: null,
      };
    }
  }

  return changes;
}
