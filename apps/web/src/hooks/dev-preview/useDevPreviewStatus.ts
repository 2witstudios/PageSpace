import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { DevPreviewHolderRef, DevPreviewServiceState, HttpPortSlotHolder } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import type { DevPreviewSandboxReach } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';

/**
 * The wire shape of `DevPreviewStatus` — `Date`s arrive as ISO strings.
 * Kept structural so the client never imports a server-only module for its
 * types beyond the pure core.
 */
export type DevPreviewStateDTO =
  | Exclude<DevPreviewServiceState, { status: 'stopped' }>
  | { status: 'stopped'; targetPort: number; stoppedAt: string; message: string };

export type DevPreviewSlotDTO =
  | { known: false }
  | { known: true; free: boolean; holder: HttpPortSlotHolder; pid: number | null; message: string };

export interface DevPreviewStatusDTO {
  holder: DevPreviewHolderRef;
  sandbox: DevPreviewSandboxReach;
  state: DevPreviewStateDTO;
  slot: DevPreviewSlotDTO;
  openPath: string | null;
  canOpen: boolean;
  canStop: boolean;
  canResume: boolean;
  detectedAt: string | null;
}

/** The status path for a session — the reader the surface uses for the selected session. */
export const sessionDevPreviewPath = (workspaceId: string): string =>
  `/api/agent-workspaces/${encodeURIComponent(workspaceId)}/preview`;

/** The status path for an environment — the reader the sidebar's env row uses. */
export const envDevPreviewPath = (driveId: string, envId: string): string =>
  `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(envId)}/preview`;

async function statusFetcher(url: string): Promise<{ preview: DevPreviewStatusDTO }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to load preview status (${response.status})`);
  return response.json();
}

/**
 * Polling read of one holder's preview status. Polling, not push, on
 * purpose for v1: the status is folded server-side from the row, a
 * control-plane service read and the realtime tier's snapshot — all cheap,
 * none of them a probe of the sprite (the never-probe-to-render rule holds
 * on every tick). `intervalMs` is the caller's: the affordance polls slowly
 * (a dev server coming up is a seconds-scale event), the open pane faster
 * (its chrome should track a relay crash within a few seconds). `null` path
 * or `enabled: false` disables the fetch entirely — that is how the
 * capability gate keeps a dark deployment from ever calling the route.
 */
export function useDevPreviewStatus(
  path: string | null,
  options: { enabled?: boolean; intervalMs?: number } = {},
): { preview: DevPreviewStatusDTO | undefined; isLoading: boolean; error: unknown; mutate: () => void } {
  const enabled = options.enabled ?? true;
  const key = enabled && path ? path : null;
  const { data, error, isLoading, mutate } = useSWR<{ preview: DevPreviewStatusDTO }>(key, statusFetcher, {
    revalidateOnFocus: false,
    refreshInterval: options.intervalMs ?? 15_000,
    shouldRetryOnError: false,
  });
  return { preview: data?.preview, isLoading, error, mutate: () => void mutate() };
}
