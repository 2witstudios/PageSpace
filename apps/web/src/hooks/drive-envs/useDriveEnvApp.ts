import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export type PublishedAppStatus =
  | 'provisioning'
  | 'building'
  | 'deploying'
  | 'running'
  | 'stopped'
  | 'parked'
  | 'destroying'
  | 'failed';

export interface DriveEnvAppDTO {
  id: string;
  status: PublishedAppStatus;
  subdomain: string;
  url: string;
  tier: 'metered' | 'dedicated';
  flyAppName: string;
  lastError: string | null;
  createdAt: string;
}

/** Transient states the build/deploy/teardown pipeline moves through — the pane polls while in one of these and stops once the app settles. */
const TRANSIENT_STATUSES: ReadonlySet<PublishedAppStatus> = new Set([
  'provisioning',
  'building',
  'deploying',
  'destroying',
]);

export const driveEnvAppKey = (driveId: string | null | undefined, envId: string | null | undefined): string | null =>
  driveId && envId ? `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(envId)}/app` : null;

async function appFetcher(url: string): Promise<{ app: DriveEnvAppDTO | null }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to load published app (${response.status})`);
  return response.json();
}

/**
 * One environment's published-app row, if it has one.
 *
 * Polls only while the row is in a TRANSIENT state (a build/deploy/teardown in
 * flight) — this is how the pane "streams build status" without its own
 * websocket: `published_apps` is already the state machine the build pipeline
 * writes to, so re-reading it on a short interval is the whole mechanism. Once
 * the app settles (`running`/`stopped`/`parked`/`failed`) or there is no app at
 * all, polling stops — the write actions below call `mutate` themselves for an
 * instant update instead of waiting on the next tick.
 */
export function useDriveEnvApp(
  driveId: string | null | undefined,
  envId: string | null | undefined,
  options?: { enabled?: boolean },
): {
  app: DriveEnvAppDTO | null | undefined;
  isLoading: boolean;
  error: unknown;
  mutate: () => void;
} {
  const enabled = options?.enabled ?? true;
  const key = enabled ? driveEnvAppKey(driveId, envId) : null;
  const { data, error, isLoading, mutate } = useSWR<{ app: DriveEnvAppDTO | null }>(key, appFetcher, {
    revalidateOnFocus: false,
    refreshInterval: (latest) => (latest?.app && TRANSIENT_STATUSES.has(latest.app.status) ? 3_000 : 0),
  });

  return { app: data?.app, isLoading, error, mutate: () => void mutate() };
}
