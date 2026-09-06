import { useEffect, useRef } from 'react';
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
  /** Whether THIS viewer may stop/resume — server-derived (`decideDevPreviewManage`); the client cannot know the drive role. */
  canManage: boolean;
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

/** Consecutive "nothing here" answers after which an affordance stops polling until something re-arms it. */
export const IDLE_ANSWERS_BEFORE_PAUSE = 4;

/** Is this answer "nothing to watch"? A holder with no dev server and no sprite has nothing that changes on its own. */
export function isIdleDevPreviewAnswer(preview: DevPreviewStatusDTO | undefined): boolean {
  return preview !== undefined && (preview.state.status === 'none' || preview.sandbox === 'absent');
}

/**
 * Pure: the interval SWR should use on the next tick, or 0 for "no timer".
 *
 *  - `active: false` (the row is collapsed, the tab is hidden) ⇒ 0.
 *  - `paneOwnsPoll` ⇒ 0 — the open pane polls this same key faster, and the
 *    affordance reads the shared cache; two timers on one key is amplification.
 *  - `idleStreak >= IDLE_ANSWERS_BEFORE_PAUSE` ⇒ 0 — an idle holder is not
 *    re-read every 15 s forever; a toggle of `active` re-arms it.
 */
export function devPreviewRefreshInterval({
  active,
  paneOwnsPoll,
  idleStreak,
  intervalMs,
}: {
  active: boolean;
  paneOwnsPoll: boolean;
  idleStreak: number;
  intervalMs: number;
}): number {
  if (!active || paneOwnsPoll) return 0;
  if (idleStreak >= IDLE_ANSWERS_BEFORE_PAUSE) return 0;
  return intervalMs;
}

/**
 * Polling read of one holder's preview status. Polling, not push, on
 * purpose for v1: the status is folded server-side from the row, a
 * control-plane service read and the realtime tier's snapshot — all cheap,
 * none of them a probe of the sprite (the never-probe-to-render rule holds
 * on every tick). But cheap × every env row × every member × forever is not
 * cheap, so the poll is DISCIPLINED (`devPreviewRefreshInterval`):
 *
 *  - it runs only while `active` (the caller's disclosure — an expanded env
 *    row, an open pane) and only while the capability is on (`enabled`);
 *  - it STOPS, not merely slows, after {@link IDLE_ANSWERS_BEFORE_PAUSE}
 *    consecutive "nothing here" answers, and re-arms when `active` toggles
 *    (collapse/expand) — or when a detection push arrives, once one exists;
 *  - one poll per holder: when the pane is open on this key (`paneOwnsPoll`)
 *    the affordance runs no timer of its own and reads the shared SWR cache;
 *  - it PAUSES WHILE THE TAB IS HIDDEN: `refreshWhenHidden: false` is SWR's
 *    default and is set explicitly here because this hook RELIES on it —
 *    a backgrounded dashboard with twenty env rows must not keep twenty
 *    gathers going. (`refreshWhenOffline: false` likewise.)
 *
 * `null` path or `enabled: false` disables the fetch entirely — that is how
 * the capability gate keeps a dark deployment from ever calling the route.
 */
export function useDevPreviewStatus(
  path: string | null,
  options: { enabled?: boolean; active?: boolean; paneOwnsPoll?: boolean; intervalMs?: number } = {},
): { preview: DevPreviewStatusDTO | undefined; isLoading: boolean; error: unknown; mutate: () => void } {
  const enabled = options.enabled ?? true;
  const active = options.active ?? true;
  const paneOwnsPoll = options.paneOwnsPoll ?? false;
  const intervalMs = options.intervalMs ?? 15_000;
  const key = enabled && path ? path : null;

  // The idle streak counts ANSWERS (in the fetcher), never evaluations of the
  // interval callback — SWR re-evaluates that on every render, and identical
  // idle answers keep the same `data` reference (deep-equal), so neither is
  // a usable count. A ref, so it never re-renders; reset by an `active`
  // toggle — the re-arm the docblock promises.
  const idleStreak = useRef(0);
  useEffect(() => {
    idleStreak.current = 0;
  }, [active, key]);

  const { data, error, isLoading, mutate } = useSWR<{ preview: DevPreviewStatusDTO }>(
    key,
    async (url: string) => {
      const answer = await statusFetcher(url);
      idleStreak.current = isIdleDevPreviewAnswer(answer.preview) ? idleStreak.current + 1 : 0;
      return answer;
    },
    {
      revalidateOnFocus: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      shouldRetryOnError: false,
      refreshInterval: () => devPreviewRefreshInterval({ active, paneOwnsPoll, idleStreak: idleStreak.current, intervalMs }),
    },
  );
  return { preview: data?.preview, isLoading, error, mutate: () => void mutate() };
}
