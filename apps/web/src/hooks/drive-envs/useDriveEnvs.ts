import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';

/**
 * A drive's environments, for every surface that needs them.
 *
 * ONE key per drive, exported, because two surfaces read the same list and one
 * of them writes it: the sidebar's environment rows and the spawn palette's
 * "in <env>" targets both mount `useDriveEnvs`, and creating or deleting an
 * environment has to refresh whichever of the two is not the one that did it.
 * Sharing the key makes that a single `mutate(driveEnvsKey(driveId))` instead
 * of a callback chain between components that never meet.
 *
 * A REFUSAL DOES NOT EMPTY THE SIDEBAR. The listing is member-gated, and a
 * caller who cannot read it (a stale drive id, a membership just revoked)
 * should still get a usable drive rather than a broken sidebar — so `envs` is
 * always an array and never throws at the render site.
 *
 * But an empty array is NOT a synonym for "this drive has none", and callers
 * must not treat it as one. Three different facts collapse into `[]`: the
 * request is still in flight, the request failed, or the drive really has no
 * environments. `isLoading` and `error` are returned so a caller can tell them
 * apart, and both of this hook's callers do: the palette's step machine waits
 * on `isLoading` rather than spawning ephemerally into a drive whose listing
 * had not landed, and the sidebar renders a retry notice on `error` rather
 * than silently presenting a drive as environment-less.
 */

export const driveEnvsKey = (driveId: string | null | undefined): string | null =>
  driveId ? `/api/drives/${encodeURIComponent(driveId)}/envs` : null;

async function envsFetcher(url: string): Promise<{ envs: DriveEnvDTO[] }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to list environments (${response.status})`);
  return response.json();
}

export function useDriveEnvs(
  driveId: string | null | undefined,
  options?: { enabled?: boolean },
): {
  envs: DriveEnvDTO[];
  isLoading: boolean;
  error: unknown;
  mutate: () => void;
} {
  const enabled = options?.enabled ?? true;
  const { data, error, isLoading, mutate } = useSWR<{ envs: DriveEnvDTO[] }>(
    enabled ? driveEnvsKey(driveId) : null,
    envsFetcher,
    {
      revalidateOnFocus: false,
      // An environment is created and destroyed deliberately, by a person, and
      // its derived status only moves when a machine is provisioned or torn
      // down. Nothing here changes on its own often enough to poll for — the
      // acts that DO change it all run through this hook's own `mutate`.
      refreshInterval: 0,
    },
  );

  return { envs: data?.envs ?? [], isLoading, error, mutate: () => void mutate() };
}
