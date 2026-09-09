import { useCallback, useEffect } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import { DRIVE_ENV_ACTIVITY_EVENT, driveEnvActivityDtoSchema, type DriveEnvActivityDTO } from '@pagespace/lib/drive-envs/env-contract';

/**
 * A local environment's activity — the server-side grant audit — LIVE
 * (GA wave 3, leaf 2).
 *
 * Two sources, one list. The HTTP read (`…/envs/<id>/activity`, owner-only)
 * is the source of truth and is re-read on mount and on reconnect; the
 * `env:activity` socket event, which reaches the machine OWNER's own room
 * for every row written or updated, upserts into the cached list by row id
 * so a grant appears the moment the server signs it and settles the moment
 * the machine answers — no polling. A row the socket delivers that the
 * listing has not seen yet is prepended; one it has seen is replaced.
 *
 * The event is filtered by `envId` client-side: the room is per OWNER, not
 * per env, so a user with two machines sees both rooms' worth of rows and
 * each panel keeps only its own.
 *
 * `enabled: false` (a viewer who is not the owner) mounts nothing: no key,
 * no listener. The 403 the route would answer is never requested, so a
 * colleague's sidebar does not fill with refusals.
 */
export interface EnvActivityKeyInput {
  driveId: string | null | undefined;
  envId: string | null | undefined;
}

export const envActivityKey = ({ driveId, envId }: EnvActivityKeyInput): string | null =>
  driveId && envId ? `/api/drives/${encodeURIComponent(driveId)}/envs/${encodeURIComponent(envId)}/activity` : null;

/** The most rows a panel keeps in memory; the route serves the same ceiling. */
export const ENV_ACTIVITY_MAX_ROWS = 50;

interface ActivityResponse {
  activity: DriveEnvActivityDTO[];
}

async function activityFetcher(url: string): Promise<ActivityResponse> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to load environment activity (${response.status})`);
  return response.json();
}

/** Upsert by id, newest first, bounded. Pure — exported for its own test. */
export function upsertActivity(current: readonly DriveEnvActivityDTO[], row: DriveEnvActivityDTO, max = ENV_ACTIVITY_MAX_ROWS): DriveEnvActivityDTO[] {
  const index = current.findIndex((entry) => entry.id === row.id);
  if (index >= 0) {
    const next = [...current];
    next[index] = row;
    return next;
  }
  return [row, ...current].slice(0, max);
}

export function useEnvActivity(
  input: EnvActivityKeyInput,
  options?: { enabled?: boolean },
): {
  activity: DriveEnvActivityDTO[];
  running: DriveEnvActivityDTO[];
  isLoading: boolean;
  error: unknown;
  refresh: () => void;
} {
  const enabled = options?.enabled ?? true;
  const key = enabled ? envActivityKey(input) : null;
  const { data, error, isLoading, mutate } = useSWR<ActivityResponse>(key, activityFetcher, { revalidateOnFocus: false });
  const { mutate: globalMutate } = useSWRConfig();
  const socket = useSocketStore((state) => state.socket);
  const envId = input.envId;

  const handleActivity = useCallback(
    (raw: unknown) => {
      const parsed = driveEnvActivityDtoSchema.safeParse(raw);
      if (!parsed.success || parsed.data.envId !== envId || key === null) return;
      const row = parsed.data;
      // Synchronous, functional: two events landing in one tick must both apply.
      void globalMutate(key, (current: ActivityResponse | undefined) => ({ activity: upsertActivity(current?.activity ?? [], row) }), { revalidate: false });
    },
    [envId, key, globalMutate],
  );

  const handleReconnect = useCallback(() => {
    if (key !== null) void mutate();
  }, [key, mutate]);

  useEffect(() => {
    if (!socket || key === null) return;
    socket.on(DRIVE_ENV_ACTIVITY_EVENT, handleActivity);
    socket.on('connect', handleReconnect);
    return () => {
      socket.off(DRIVE_ENV_ACTIVITY_EVENT, handleActivity);
      socket.off('connect', handleReconnect);
    };
  }, [socket, key, handleActivity, handleReconnect]);

  const activity = data?.activity ?? [];
  return {
    activity,
    running: activity.filter((row) => row.verdict === 'signed' && row.resultAt === null),
    isLoading,
    error,
    refresh: () => void mutate(),
  };
}
