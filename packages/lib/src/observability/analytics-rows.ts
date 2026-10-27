/**
 * Pure row mapping for the ClickHouse analytics tier (#890 Phase 3 leaf 2).
 *
 * The write shapes mirror the main-PG writers in logging/logger-database.ts
 * (camelCase, optional fields); the row shapes mirror the ClickHouse columns
 * (snake_case, explicit null). Mapping is pure — id and timestamp are
 * resolved by the caller and passed in, jsonb-shaped metadata serializes to a
 * JSON string (CH String column), undefined becomes SQL NULL.
 */

export const ANALYTICS_TABLES = {
  apiMetrics: 'api_metrics',
  systemLogs: 'system_logs',
  userActivities: 'user_activities',
  errorLogs: 'error_logs',
} as const;

export type AnalyticsTable = (typeof ANALYTICS_TABLES)[keyof typeof ANALYTICS_TABLES];

/** id/timestamp resolved by the shell (caller-provided or generated). */
export interface AssignedRowIdentity {
  id: string;
  timestamp: Date;
}

/**
 * UTC `YYYY-MM-DD HH:mm:ss.SSS` — the shape ClickHouse's basic date parser
 * accepts for DateTime64(3, 'UTC') columns over JSONEachRow.
 */
export const toClickHouseDateTime64 = (date: Date): string =>
  date.toISOString().replace('T', ' ').replace('Z', '');

const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

// JSON.stringify(undefined) is undefined, not a string — map that to NULL too.
// Circular metadata throws here; the adapter shell absorbs it (never-throw).
const metadataToJson = (metadata: unknown): string | null => {
  if (metadata === undefined || metadata === null) return null;
  const serialized = JSON.stringify(metadata);
  return serialized === undefined ? null : serialized;
};

// ── api_metrics ──────────────────────────────────────────────────────────────

export interface ApiMetricWrite {
  id?: string;
  timestamp?: Date;
  endpoint: string;
  method: string;
  statusCode: number;
  duration: number;
  requestSize?: number;
  responseSize?: number;
  userId?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  error?: string;
  requestId?: string;
  cacheHit?: boolean;
  cacheKey?: string;
}

export type ApiMetricRow = {
  id: string;
  timestamp: string;
  endpoint: string;
  method: string;
  status_code: number;
  duration: number;
  request_size: number | null;
  response_size: number | null;
  user_id: string | null;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  error: string | null;
  request_id: string | null;
  cache_hit: boolean | null;
  cache_key: string | null;
}

export const mapApiMetricToRow = (
  input: ApiMetricWrite,
  assigned: AssignedRowIdentity,
): ApiMetricRow => ({
  id: assigned.id,
  timestamp: toClickHouseDateTime64(assigned.timestamp),
  endpoint: input.endpoint,
  method: input.method,
  status_code: input.statusCode,
  duration: input.duration,
  request_size: orNull(input.requestSize),
  response_size: orNull(input.responseSize),
  user_id: orNull(input.userId),
  session_id: orNull(input.sessionId),
  ip: orNull(input.ip),
  user_agent: orNull(input.userAgent),
  error: orNull(input.error),
  request_id: orNull(input.requestId),
  cache_hit: orNull(input.cacheHit),
  cache_key: orNull(input.cacheKey),
});

// ── system_logs ──────────────────────────────────────────────────────────────

export interface SystemLogWrite {
  id?: string;
  timestamp?: Date;
  level: string;
  message: string;
  category?: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  driveId?: string;
  pageId?: string;
  endpoint?: string;
  method?: string;
  ip?: string;
  userAgent?: string;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
  duration?: number;
  memoryUsed?: number;
  memoryTotal?: number;
  metadata?: unknown;
  hostname?: string;
  pid?: number;
  version?: string;
}

export type SystemLogRow = {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  /** ORDER BY key — non-nullable in CH, PG NULL maps to ''. */
  category: string;
  user_id: string | null;
  session_id: string | null;
  request_id: string | null;
  drive_id: string | null;
  page_id: string | null;
  endpoint: string | null;
  method: string | null;
  ip: string | null;
  user_agent: string | null;
  error_name: string | null;
  error_message: string | null;
  error_stack: string | null;
  duration: number | null;
  memory_used: number | null;
  memory_total: number | null;
  metadata: string | null;
  hostname: string | null;
  pid: number | null;
  version: string | null;
}

export const mapSystemLogToRow = (
  input: SystemLogWrite,
  assigned: AssignedRowIdentity,
): SystemLogRow => ({
  id: assigned.id,
  timestamp: toClickHouseDateTime64(assigned.timestamp),
  level: input.level,
  message: input.message,
  category: input.category ?? '',
  user_id: orNull(input.userId),
  session_id: orNull(input.sessionId),
  request_id: orNull(input.requestId),
  drive_id: orNull(input.driveId),
  page_id: orNull(input.pageId),
  endpoint: orNull(input.endpoint),
  method: orNull(input.method),
  ip: orNull(input.ip),
  user_agent: orNull(input.userAgent),
  error_name: orNull(input.errorName),
  error_message: orNull(input.errorMessage),
  error_stack: orNull(input.errorStack),
  duration: orNull(input.duration),
  memory_used: orNull(input.memoryUsed),
  memory_total: orNull(input.memoryTotal),
  metadata: metadataToJson(input.metadata),
  hostname: orNull(input.hostname),
  pid: orNull(input.pid),
  version: orNull(input.version),
});

// ── user_activities ──────────────────────────────────────────────────────────

export interface UserActivityWrite {
  id?: string;
  timestamp?: Date;
  userId: string;
  action: string;
  resource?: string;
  resourceId?: string;
  driveId?: string;
  pageId?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: unknown;
}

export type UserActivityRow = {
  id: string;
  timestamp: string;
  user_id: string;
  action: string;
  session_id: string | null;
  resource: string | null;
  resource_id: string | null;
  drive_id: string | null;
  page_id: string | null;
  metadata: string | null;
  ip: string | null;
  user_agent: string | null;
}

export const mapUserActivityToRow = (
  input: UserActivityWrite,
  assigned: AssignedRowIdentity,
): UserActivityRow => ({
  id: assigned.id,
  timestamp: toClickHouseDateTime64(assigned.timestamp),
  user_id: input.userId,
  action: input.action,
  session_id: orNull(input.sessionId),
  resource: orNull(input.resource),
  resource_id: orNull(input.resourceId),
  drive_id: orNull(input.driveId),
  page_id: orNull(input.pageId),
  metadata: metadataToJson(input.metadata),
  ip: orNull(input.ip),
  user_agent: orNull(input.userAgent),
});

// ── error_logs ───────────────────────────────────────────────────────────────

export interface ErrorLogWrite {
  id?: string;
  timestamp?: Date;
  name: string;
  message: string;
  stack?: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  endpoint?: string;
  method?: string;
  file?: string;
  line?: number;
  column?: number;
  ip?: string;
  userAgent?: string;
  metadata?: unknown;
}

export type ErrorLogRow = {
  id: string;
  timestamp: string;
  name: string;
  message: string;
  stack: string | null;
  user_id: string | null;
  session_id: string | null;
  request_id: string | null;
  endpoint: string | null;
  method: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  ip: string | null;
  user_agent: string | null;
  metadata: string | null;
}

export const mapErrorLogToRow = (
  input: ErrorLogWrite,
  assigned: AssignedRowIdentity,
): ErrorLogRow => ({
  id: assigned.id,
  timestamp: toClickHouseDateTime64(assigned.timestamp),
  name: input.name,
  message: input.message,
  stack: orNull(input.stack),
  user_id: orNull(input.userId),
  session_id: orNull(input.sessionId),
  request_id: orNull(input.requestId),
  endpoint: orNull(input.endpoint),
  method: orNull(input.method),
  file: orNull(input.file),
  line: orNull(input.line),
  column: orNull(input.column),
  ip: orNull(input.ip),
  user_agent: orNull(input.userAgent),
  metadata: metadataToJson(input.metadata),
});
