import { useCallback, useEffect, useRef } from 'react';
import useSWR, { type SWRConfiguration } from 'swr';
import { fetchJSON } from '@/lib/auth/auth-fetch';
import type { DevPreviewServiceState } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import type { DevPreviewStatus } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';

/** The wire shape of the core's state — `Date`s arrive as ISO strings. */
export type DevPreviewStateDTO =
  | Exclude<DevPreviewServiceState, { status: 'stopped' }>
  | { status: 'stopped'; targetPort: number; stoppedAt: string; message: string };

/**
 * The wire shape of `DevPreviewStatus` (type-only import — erased, so the
 * client bundle pulls no server code): the server's read model with its
 * dates as strings, plus the route's own `canManage`.
 */
export type DevPreviewStatusDTO = Omit<DevPreviewStatus, 'state' | 'detectedAt'> & {
  /** Whether THIS viewer may stop/resume — server-derived (`canManageDevPreview`); the client cannot know the drive role. */
  canManage: boolean;
  state: DevPreviewStateDTO;
  detectedAt: string | null;
};

/** The status path for a session — the reader the surface uses for the selected session. */
export const sessionDevPreviewPath = (workspaceId: string): string =>
  `/api/agent-workspaces/${encodeURIComponent(workspaceId)}/preview`;

/** The status path for an environment — the reader the sidebar's env row uses. */
export const envDevPreviewPath = (driveId: string, envId: string): string =>
  `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(envId)}/preview`;

/** The actions route for a status path — one derivation, so a caller can never pair them wrongly. */
export const devPreviewActionsPath = (statusPath: string): string => `${statusPath}/actions`;

/**
 * `fetchJSON`, not a hand-rolled `fetchWithAuth` + `ok` check: the
 * authenticated fetch never throws on a 4xx, and the pane's "the holder is
 * gone" self-close needs the REAL `ApiRequestError` with its `status`.
 */
const statusFetcher = (url: string): Promise<{ preview: DevPreviewStatusDTO }> => fetchJSON<{ preview: DevPreviewStatusDTO }>(url);

/** Consecutive "nothing here" answers after which an affordance stops polling until something re-arms it. */
export const IDLE_ANSWERS_BEFORE_PAUSE = 4;

/** Is this answer "nothing to watch"? A holder with no dev server and no sprite has nothing that changes on its own. */
export function isIdleDevPreviewAnswer(preview: DevPreviewStatusDTO | undefined): boolean {
  return preview !== undefined && (preview.state.status === 'none' || preview.sandbox === 'absent');
}

/**
 * Pure: the interval SWR should use on the next tick, or 0 for "no timer".
 * Two independent decisions:
 *
 *  - `polling: false` ⇒ 0. The caller answers "should THIS hook instance run
 *    a timer at all?" — an env row says `expanded && !paneOpenOnThisHolder`
 *    (the open pane polls the same key faster and the row reads the shared
 *    cache; two timers on one key is amplification), the console header and
 *    the pane say `true`.
 *  - `pauseWhenIdle` and `idleStreak >= IDLE_ANSWERS_BEFORE_PAUSE` ⇒ 0 — an
 *    idle holder is not re-read every 15 s forever; `polling` flipping back
 *    to true re-arms it. Surfaces with NO disclosure to re-arm from (the
 *    console header, the open pane — one per viewer, not one per row) opt
 *    out, or a dev server started a minute later would never be noticed.
 */
export function devPreviewRefreshInterval({
  polling,
  pauseWhenIdle,
  idleStreak,
  intervalMs,
}: {
  polling: boolean;
  pauseWhenIdle: boolean;
  idleStreak: number;
  intervalMs: number;
}): number {
  if (!polling) return 0;
  if (pauseWhenIdle && idleStreak >= IDLE_ANSWERS_BEFORE_PAUSE) return 0;
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
 *  - it runs a timer only while the caller says `polling` (an expanded env
 *    row whose holder is not already open in the pane — one poll per holder,
 *    the pane's; the console header and the pane always) and only while the
 *    capability is on (`enabled`);
 *  - with `pauseWhenIdle` (the default — every per-row surface) it STOPS,
 *    not merely slows, after {@link IDLE_ANSWERS_BEFORE_PAUSE} consecutive
 *    "nothing here" answers, and re-arms whenever `polling` flips back to
 *    true (expand, pane closed) — or when a detection push arrives, once
 *    one exists. A per-VIEWER surface with no disclosure (the console header
 *    for the selected session, the open pane) passes `pauseWhenIdle: false`:
 *    it is O(1) per viewer, and stopping it would mean a dev server started
 *    a minute after the session was opened is never surfaced;
 *  - it PAUSES WHILE THE TAB IS HIDDEN: `refreshWhenHidden: false` is SWR's
 *    default and is set explicitly here because this hook RELIES on it —
 *    a backgrounded dashboard with twenty env rows must not keep twenty
 *    gathers going. (`refreshWhenOffline: false` likewise.)
 *  - a FAILED poll does not freeze it: SWR skips interval revalidation while
 *    an error is cached, so without a retry policy one transient 500 would
 *    stop the status forever. `onErrorRetry` re-asks at the same disciplined
 *    interval (never faster, never past the idle stop), keeping the last
 *    good answer on screen meanwhile.
 *
 * The interval callback is memoized: SWR restarts its timer whenever that
 * function's identity changes, so an inline arrow in a component that
 * re-renders often (the console header while a chat streams) would keep
 * resetting the timer and never fire.
 *
 * `null` path or `enabled: false` disables the fetch entirely — that is how
 * the capability gate keeps a dark deployment from ever calling the route.
 */
export function useDevPreviewStatus(
  path: string | null,
  options: { enabled?: boolean; polling?: boolean; pauseWhenIdle?: boolean; intervalMs?: number } = {},
): { preview: DevPreviewStatusDTO | undefined; isLoading: boolean; error: unknown; mutate: () => void } {
  const enabled = options.enabled ?? true;
  const polling = options.polling ?? true;
  const pauseWhenIdle = options.pauseWhenIdle ?? true;
  const intervalMs = options.intervalMs ?? 15_000;
  const key = enabled && path ? path : null;

  // The idle streak counts ANSWERS (in the fetcher), never evaluations of the
  // interval callback — SWR re-evaluates that on every render, and identical
  // idle answers keep the same `data` reference (deep-equal), so neither is
  // a usable count. A ref, so it never re-renders; reset whenever `polling`
  // flips (or the key changes) — the re-arm the docblock promises.
  const idleStreak = useRef(0);
  useEffect(() => {
    idleStreak.current = 0;
  }, [polling, key]);

  const nextInterval = useCallback(
    () => devPreviewRefreshInterval({ polling, pauseWhenIdle, idleStreak: idleStreak.current, intervalMs }),
    [polling, pauseWhenIdle, intervalMs],
  );
  const onErrorRetry = useCallback<NonNullable<SWRConfiguration['onErrorRetry']>>(
    (_error, _key, _config, revalidate, { retryCount }) => {
      const ms = nextInterval();
      if (ms > 0) setTimeout(() => void revalidate({ retryCount }), ms);
    },
    [nextInterval],
  );

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
      shouldRetryOnError: true,
      onErrorRetry,
      refreshInterval: nextInterval,
    },
  );
  const refresh = useCallback(() => void mutate(), [mutate]);
  return { preview: data?.preview, isLoading, error, mutate: refresh };
}
