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
 * A REFUSAL IS NOT AN ERROR STATE HERE. The listing is member-gated, and a
 * caller who cannot read it (a stale drive id, a membership just revoked)
 * should see a drive with no environments — not a broken sidebar. So `envs`
 * is always an array, and `error` is surfaced separately for the one caller
 * that wants to say something about it.
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
