import type { ScanEnvironmentFacts } from '@pagespace/lib/content-safety/readiness';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Ask the web app for its content-scanning environment (booleans only). Only the
 * web app holds HIVE_API_KEY, EVIDENCE_BUCKET and the scan mode it publishes
 * with. Same server-to-server pattern as the takedown proxy. Null when the web
 * app can't be asked: readiness then shows those checks as unknown (blocking).
 */
const READINESS_PATH = '/api/internal/content-safety/readiness';
const TIMEOUT_MS = 10_000;

const BOOLEAN_KEYS = ['onPrem', 'hiveKeySet', 'evidenceBucketSet', 'abuseEmailSet', 'publishBucketSet', 'allowUnclassifiedVideo'] as const;

function isFacts(value: unknown): value is ScanEnvironmentFacts {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    BOOLEAN_KEYS.every((key) => typeof record[key] === 'boolean') &&
    ['off', 'shadow', 'enforce'].includes(record.mode as string) &&
    Array.isArray(record.problems)
  );
}

export async function fetchWebScanEnvironment(adminUserId: string): Promise<ScanEnvironmentFacts | null> {
  const webUrl = process.env.WEB_APP_INTERNAL_URL ?? process.env.NEXT_PUBLIC_WEB_APP_URL;
  const serviceSecret = process.env.SERVICE_API_SECRET;
  if (!webUrl || !serviceSecret) return null;
  try {
    const response = await fetch(new URL(READINESS_PATH, webUrl).toString(), {
      headers: { 'x-service-secret': serviceSecret, 'x-service-user-id': adminUserId },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    return isFacts(body) ? body : null;
  } catch (error) {
    loggers.security.warn('Content readiness: could not reach the web app', { error: error instanceof Error ? error.name : 'unknown' });
    return null;
  }
}
