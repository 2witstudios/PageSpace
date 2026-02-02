/**
 * Audit Log Repository
 *
 * Database operations for integration audit logs.
 * Every external API call is logged for security and debugging.
 */

import {
  db as defaultDb,
  eq,
  and,
  desc,
  gte,
  lte,
  integrationAuditLog,
  type IntegrationAuditLogEntry,
  type NewIntegrationAuditLogEntry,
} from '@pagespace/db';

interface QueryOptions {
  limit?: number;
  offset?: number;
}

/**
 * Log an audit entry for an API call.
 */
export const logAuditEntry = async (
  database: typeof defaultDb,
  entry: NewIntegrationAuditLogEntry
): Promise<IntegrationAuditLogEntry> => {
  const [logged] = await database
    .insert(integrationAuditLog)
    .values(entry)
    .returning();

  return logged;
};

/**
 * Get audit logs for a drive.
 */
export const getAuditLogsByDrive = async (
  database: typeof defaultDb,
  driveId: string,
  options: QueryOptions = {}
): Promise<IntegrationAuditLogEntry[]> => {
  const { limit = 100, offset = 0 } = options;

  const logs = await database.query.integrationAuditLog.findMany({
    where: eq(integrationAuditLog.driveId, driveId),
    orderBy: [desc(integrationAuditLog.createdAt)],
    limit,
    offset,
  });

  return logs;
};

/**
 * Get audit logs for a connection.
 */
export const getAuditLogsByConnection = async (
  database: typeof defaultDb,
  connectionId: string,
  options: QueryOptions = {}
): Promise<IntegrationAuditLogEntry[]> => {
  const { limit = 100, offset = 0 } = options;

  const logs = await database.query.integrationAuditLog.findMany({
    where: eq(integrationAuditLog.connectionId, connectionId),
    orderBy: [desc(integrationAuditLog.createdAt)],
    limit,
    offset,
  });

  return logs;
};

/**
 * Get audit logs within a date range.
 */
export const getAuditLogsByDateRange = async (
  database: typeof defaultDb,
  driveId: string,
  startDate: Date,
  endDate: Date,
  options: QueryOptions = {}
): Promise<IntegrationAuditLogEntry[]> => {
  const { limit = 1000, offset = 0 } = options;

  const logs = await database.query.integrationAuditLog.findMany({
    where: and(
      eq(integrationAuditLog.driveId, driveId),
      gte(integrationAuditLog.createdAt, startDate),
      lte(integrationAuditLog.createdAt, endDate)
    ),
    orderBy: [desc(integrationAuditLog.createdAt)],
    limit,
    offset,
  });

  return logs;
};

/**
 * Get audit logs filtered by success/failure.
 */
export const getAuditLogsBySuccess = async (
  database: typeof defaultDb,
  driveId: string,
  success: boolean,
  options: QueryOptions = {}
): Promise<IntegrationAuditLogEntry[]> => {
  const { limit = 100, offset = 0 } = options;

  const logs = await database.query.integrationAuditLog.findMany({
    where: and(
      eq(integrationAuditLog.driveId, driveId),
      eq(integrationAuditLog.success, success)
    ),
    orderBy: [desc(integrationAuditLog.createdAt)],
    limit,
    offset,
  });

  return logs;
};

/**
 * Get audit logs for a specific agent.
 */
export const getAuditLogsByAgent = async (
  database: typeof defaultDb,
  agentId: string,
  options: QueryOptions = {}
): Promise<IntegrationAuditLogEntry[]> => {
  const { limit = 100, offset = 0 } = options;

  const logs = await database.query.integrationAuditLog.findMany({
    where: eq(integrationAuditLog.agentId, agentId),
    orderBy: [desc(integrationAuditLog.createdAt)],
    limit,
    offset,
  });

  return logs;
};

/**
 * Get audit logs for a specific tool.
 */
export const getAuditLogsByTool = async (
  database: typeof defaultDb,
  driveId: string,
  toolName: string,
  options: QueryOptions = {}
): Promise<IntegrationAuditLogEntry[]> => {
  const { limit = 100, offset = 0 } = options;

  const logs = await database.query.integrationAuditLog.findMany({
    where: and(
      eq(integrationAuditLog.driveId, driveId),
      eq(integrationAuditLog.toolName, toolName)
    ),
    orderBy: [desc(integrationAuditLog.createdAt)],
    limit,
    offset,
  });

  return logs;
};

/**
 * Count audit logs by error type for a drive.
 */
export const countAuditLogsByErrorType = async (
  database: typeof defaultDb,
  driveId: string,
  startDate?: Date,
  endDate?: Date
): Promise<Array<{ errorType: string; count: number }>> => {
  let whereClause = eq(integrationAuditLog.driveId, driveId);

  if (startDate && endDate) {
    whereClause = and(
      whereClause,
      gte(integrationAuditLog.createdAt, startDate),
      lte(integrationAuditLog.createdAt, endDate)
    )!;
  }

  const logs = await database.query.integrationAuditLog.findMany({
    where: whereClause,
    columns: {
      errorType: true,
    },
  });

  // Group by errorType
  const counts = new Map<string, number>();
  for (const log of logs) {
    if (log.errorType) {
      counts.set(log.errorType, (counts.get(log.errorType) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries()).map(([errorType, count]) => ({
    errorType,
    count,
  }));
};
