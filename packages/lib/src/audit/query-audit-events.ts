/**
 * Query utilities for audit events
 *
 * Provides high-level functions for querying audit trail data.
 */

import {
  db,
  auditEvents,
  eq,
  and,
  desc,
  inArray,
  gte,
  lte,
  sql,
} from '@pagespace/db';

export interface AuditEventFilters {
  driveId?: string;
  userId?: string;
  entityType?: string;
  entityId?: string;
  actionType?: string;
  isAiAction?: boolean;
  operationId?: string;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Gets audit events with optional filters
 *
 * @param filters - Filter criteria
 * @param limit - Maximum number of events to return
 * @returns Array of audit events
 */
export async function getAuditEvents(
  filters: AuditEventFilters = {},
  limit = 100
) {
  const conditions = [];

  if (filters.driveId) {
    conditions.push(eq(auditEvents.driveId, filters.driveId));
  }

  if (filters.userId) {
    conditions.push(eq(auditEvents.userId, filters.userId));
  }

  if (filters.entityType) {
    conditions.push(eq(auditEvents.entityType, filters.entityType as any));
  }

  if (filters.entityId) {
    conditions.push(eq(auditEvents.entityId, filters.entityId));
  }

  if (filters.actionType) {
    conditions.push(eq(auditEvents.actionType, filters.actionType as any));
  }

  if (filters.isAiAction !== undefined) {
    conditions.push(eq(auditEvents.isAiAction, filters.isAiAction));
  }

  if (filters.operationId) {
    conditions.push(eq(auditEvents.operationId, filters.operationId));
  }

  if (filters.startDate) {
    conditions.push(gte(auditEvents.createdAt, filters.startDate));
  }

  if (filters.endDate) {
    conditions.push(lte(auditEvents.createdAt, filters.endDate));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  return await db.query.auditEvents.findMany({
    where,
    orderBy: [desc(auditEvents.createdAt)],
    limit,
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      aiOperation: {
        columns: {
          agentType: true,
          model: true,
          prompt: true,
        },
      },
    },
  });
}

/**
 * Gets activity feed for a drive
 *
 * @param driveId - Drive ID
 * @param limit - Maximum number of events to return
 * @returns Array of audit events
 */
export async function getDriveActivityFeed(driveId: string, limit = 50) {
  return await getAuditEvents({ driveId }, limit);
}

/**
 * Gets activity timeline for a user
 *
 * @param userId - User ID
 * @param limit - Maximum number of events to return
 * @returns Array of audit events
 */
export async function getUserActivityTimeline(userId: string, limit = 100) {
  return await getAuditEvents({ userId }, limit);
}

/**
 * Gets history for a specific entity (page, drive, etc.)
 *
 * @param entityType - Type of entity
 * @param entityId - Entity ID
 * @param limit - Maximum number of events to return
 * @returns Array of audit events
 */
export async function getEntityHistory(
  entityType: string,
  entityId: string,
  limit = 100
) {
  return await getAuditEvents({ entityType, entityId }, limit);
}

/**
 * Gets only AI-generated actions for a drive
 *
 * @param driveId - Drive ID
 * @param limit - Maximum number of events to return
 * @returns Array of AI audit events
 */
export async function getDriveAiActivity(driveId: string, limit = 50) {
  return await getAuditEvents({ driveId, isAiAction: true }, limit);
}

/**
 * Gets only human actions for a drive
 *
 * @param driveId - Drive ID
 * @param limit - Maximum number of events to return
 * @returns Array of human audit events
 */
export async function getDriveHumanActivity(driveId: string, limit = 50) {
  return await getAuditEvents({ driveId, isAiAction: false }, limit);
}

/**
 * Gets all events for a grouped operation
 *
 * @param operationId - Operation ID
 * @returns Array of audit events in chronological order
 */
export async function getOperationEvents(operationId: string) {
  return await db.query.auditEvents.findMany({
    where: eq(auditEvents.operationId, operationId),
    orderBy: [desc(auditEvents.createdAt)],
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      aiOperation: true,
    },
  });
}

/**
 * Gets recent activity across multiple drives (for user dashboard)
 *
 * @param driveIds - Array of drive IDs user has access to
 * @param limit - Maximum number of events to return
 * @returns Array of audit events
 */
export async function getMultiDriveActivity(
  driveIds: string[],
  limit = 100
) {
  if (driveIds.length === 0) {
    return [];
  }

  return await db.query.auditEvents.findMany({
    where: inArray(auditEvents.driveId, driveIds),
    orderBy: [desc(auditEvents.createdAt)],
    limit,
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      drive: {
        columns: {
          id: true,
          name: true,
        },
      },
      aiOperation: {
        columns: {
          agentType: true,
          model: true,
        },
      },
    },
  });
}

/**
 * Gets activity for a date range
 *
 * @param driveId - Drive ID
 * @param startDate - Start date
 * @param endDate - End date
 * @param limit - Maximum number of events to return
 * @returns Array of audit events
 */
export async function getDriveActivityByDateRange(
  driveId: string,
  startDate: Date,
  endDate: Date,
  limit = 1000
) {
  return await getAuditEvents({ driveId, startDate, endDate }, limit);
}

/**
 * Gets activity statistics for a drive
 *
 * @param driveId - Drive ID
 * @param days - Number of days to look back (default: 30)
 * @returns Activity statistics
 */
export async function getDriveActivityStats(driveId: string, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const events = await db.query.auditEvents.findMany({
    where: and(
      eq(auditEvents.driveId, driveId),
      gte(auditEvents.createdAt, startDate)
    ),
    columns: {
      actionType: true,
      isAiAction: true,
      userId: true,
    },
  });

  const total = events.length;
  const aiActions = events.filter((e) => e.isAiAction).length;
  const humanActions = total - aiActions;

  const uniqueUsers = new Set(events.map((e) => e.userId).filter(Boolean)).size;

  const actionTypeCounts: Record<string, number> = {};
  for (const event of events) {
    actionTypeCounts[event.actionType] =
      (actionTypeCounts[event.actionType] || 0) + 1;
  }

  return {
    total,
    aiActions,
    humanActions,
    aiPercentage: total > 0 ? (aiActions / total) * 100 : 0,
    uniqueUsers,
    actionTypeCounts,
  };
}

/**
 * Searches audit events by description or reason
 *
 * @param driveId - Drive ID
 * @param searchTerm - Search term
 * @param limit - Maximum number of events to return
 * @returns Array of matching audit events
 */
export async function searchAuditEvents(
  driveId: string,
  searchTerm: string,
  limit = 50
) {
  return await db.query.auditEvents.findMany({
    where: and(
      eq(auditEvents.driveId, driveId),
      sql`(
        ${auditEvents.description} ILIKE ${`%${searchTerm}%`} OR
        ${auditEvents.reason} ILIKE ${`%${searchTerm}%`}
      )`
    ),
    orderBy: [desc(auditEvents.createdAt)],
    limit,
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      aiOperation: {
        columns: {
          agentType: true,
          model: true,
        },
      },
    },
  });
}

/**
 * Gets the most recent event for an entity
 *
 * @param entityType - Entity type
 * @param entityId - Entity ID
 * @returns Most recent audit event, or null
 */
export async function getLatestEntityEvent(
  entityType: string,
  entityId: string
) {
  return await db.query.auditEvents.findFirst({
    where: and(
      eq(auditEvents.entityType, entityType as any),
      eq(auditEvents.entityId, entityId)
    ),
    orderBy: [desc(auditEvents.createdAt)],
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
    },
  });
}

/**
 * Gets events by action type
 *
 * @param driveId - Drive ID
 * @param actionType - Action type to filter by
 * @param limit - Maximum number of events to return
 * @returns Array of audit events
 */
export async function getEventsByActionType(
  driveId: string,
  actionType: string,
  limit = 100
) {
  return await getAuditEvents({ driveId, actionType }, limit);
}

/**
 * Gets page-specific audit events
 *
 * @param pageId - Page ID
 * @param limit - Maximum number of events to return
 * @returns Array of page audit events
 */
export async function getPageAuditEvents(pageId: string, limit = 100) {
  return await getAuditEvents(
    { entityType: 'PAGE', entityId: pageId },
    limit
  );
}

/**
 * Gets permission-related audit events for a page
 *
 * @param pageId - Page ID
 * @param limit - Maximum number of events to return
 * @returns Array of permission audit events
 */
export async function getPagePermissionEvents(pageId: string, limit = 50) {
  return await db.query.auditEvents.findMany({
    where: and(
      eq(auditEvents.entityId, pageId),
      inArray(auditEvents.actionType, [
        'PERMISSION_GRANT',
        'PERMISSION_REVOKE',
        'PERMISSION_UPDATE',
      ] as any)
    ),
    orderBy: [desc(auditEvents.createdAt)],
    limit,
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
    },
  });
}
