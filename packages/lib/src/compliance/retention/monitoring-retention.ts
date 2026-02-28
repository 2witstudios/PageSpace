import { lt } from 'drizzle-orm';
import { db, apiMetrics, systemLogs, securityAuditLog } from '@pagespace/db';
import type { CleanupResult } from './retention-engine';

const DEFAULT_API_METRICS_DAYS = 90;
const DEFAULT_SYSTEM_LOGS_DAYS = 30;
const DEFAULT_SECURITY_AUDIT_DAYS = 365;

export interface RetentionConfig {
  apiMetricsDays: number;
  systemLogsDays: number;
  securityAuditDays: number;
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
    securityAuditDays: parsePositiveInt(process.env.RETENTION_SECURITY_AUDIT_DAYS, DEFAULT_SECURITY_AUDIT_DAYS),
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

export async function cleanupSecurityAuditLog(opts: { retentionDays: number }): Promise<CleanupResult> {
  const cutoff = getRetentionCutoff(opts.retentionDays);
  const result = await db
    .delete(securityAuditLog)
    .where(lt(securityAuditLog.timestamp, cutoff))
    .returning({ id: securityAuditLog.id });
  return { table: 'security_audit_log', deleted: result.length };
}

export async function runMonitoringRetentionCleanup(): Promise<CleanupResult[]> {
  const config = getRetentionConfig();
  const results = await Promise.all([
    cleanupApiMetrics({ retentionDays: config.apiMetricsDays }),
    cleanupSystemLogs({ retentionDays: config.systemLogsDays }),
    cleanupSecurityAuditLog({ retentionDays: config.securityAuditDays }),
  ]);
  return results;
}
