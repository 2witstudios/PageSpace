import { lt } from 'drizzle-orm';
import { db, apiMetrics, systemLogs, errorLogs, userActivities } from '@pagespace/db';
import type { CleanupResult } from './retention-engine';

const DEFAULT_API_METRICS_DAYS = 90;
const DEFAULT_SYSTEM_LOGS_DAYS = 30;
const DEFAULT_ERROR_LOGS_DAYS = 90;
const DEFAULT_USER_ACTIVITIES_DAYS = 180;

export interface RetentionConfig {
  apiMetricsDays: number;
  systemLogsDays: number;
  errorLogsDays: number;
  userActivitiesDays: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getRetentionConfig(): RetentionConfig {
  return {
    apiMetricsDays: parsePositiveInt(process.env.RETENTION_API_METRICS_DAYS, DEFAULT_API_METRICS_DAYS),
    systemLogsDays: parsePositiveInt(process.env.RETENTION_SYSTEM_LOGS_DAYS, DEFAULT_SYSTEM_LOGS_DAYS),
    errorLogsDays: parsePositiveInt(process.env.RETENTION_ERROR_LOGS_DAYS, DEFAULT_ERROR_LOGS_DAYS),
    userActivitiesDays: parsePositiveInt(process.env.RETENTION_USER_ACTIVITIES_DAYS, DEFAULT_USER_ACTIVITIES_DAYS),
  };
}

export function getRetentionCutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function cleanupApiMetrics(opts: { retentionDays: number }): Promise<CleanupResult> {
  const cutoff = getRetentionCutoff(opts.retentionDays);
  const result = await db
    .delete(apiMetrics)
    .where(lt(apiMetrics.timestamp, cutoff))
    .returning({ id: apiMetrics.id });
  return { table: 'api_metrics', deleted: result.length };
}

export async function cleanupSystemLogs(opts: { retentionDays: number }): Promise<CleanupResult> {
  const cutoff = getRetentionCutoff(opts.retentionDays);
  const result = await db
    .delete(systemLogs)
    .where(lt(systemLogs.timestamp, cutoff))
    .returning({ id: systemLogs.id });
  return { table: 'system_logs', deleted: result.length };
}

export async function cleanupErrorLogs(opts: { retentionDays: number }): Promise<CleanupResult> {
  const cutoff = getRetentionCutoff(opts.retentionDays);
  const result = await db
    .delete(errorLogs)
    .where(lt(errorLogs.timestamp, cutoff))
    .returning({ id: errorLogs.id });
  return { table: 'error_logs', deleted: result.length };
}

export async function cleanupUserActivities(opts: { retentionDays: number }): Promise<CleanupResult> {
  const cutoff = getRetentionCutoff(opts.retentionDays);
  const result = await db
    .delete(userActivities)
    .where(lt(userActivities.timestamp, cutoff))
    .returning({ id: userActivities.id });
  return { table: 'user_activities', deleted: result.length };
}

// security_audit_log is intentionally excluded — tamper-evident hash chain
// requires infinite retention to preserve chain integrity for verification
// (GDPR Art 17(3)(b) legal-obligation justification).

export async function runMonitoringRetentionCleanup(): Promise<CleanupResult[]> {
  const config = getRetentionConfig();
  const results = await Promise.all([
    cleanupApiMetrics({ retentionDays: config.apiMetricsDays }),
    cleanupSystemLogs({ retentionDays: config.systemLogsDays }),
    cleanupErrorLogs({ retentionDays: config.errorLogsDays }),
    cleanupUserActivities({ retentionDays: config.userActivitiesDays }),
  ]);
  return results;
}
