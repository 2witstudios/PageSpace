import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { DriveEnvApprovalDTO, DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';

/**
 * The account page's two reads (GA wave 3, leaf 5): the caller's machines
 * across every drive, and every durable approval in force on them — both
 * selected by OWNER on the server, so neither can ever hold anyone else's
 * machine. Each returns a stable empty array while loading or refused, with
 * `isLoading` / `isError` beside it so the page can tell the three apart.
 */

async function jsonFetcher<T>(url: string): Promise<T> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export const OWNER_APPROVALS_KEY = '/api/env-bridge/approvals';
export const OWNER_MACHINES_KEY = '/api/env-bridge/machines';

export function useEnvApprovals(): { approvals: DriveEnvApprovalDTO[]; isLoading: boolean; isError: boolean; refetch: () => void } {
  const { data, error, isLoading, mutate } = useSWR<{ approvals: DriveEnvApprovalDTO[] }>(OWNER_APPROVALS_KEY, jsonFetcher, { revalidateOnFocus: false });
  return { approvals: data?.approvals ?? [], isLoading, isError: error !== undefined, refetch: () => void mutate() };
}

export interface OwnerMachine {
  env: DriveEnvDTO;
  driveId: string;
}

export function useOwnerMachines(): { machines: OwnerMachine[]; isLoading: boolean; isError: boolean; refetch: () => void } {
  const { data, error, isLoading, mutate } = useSWR<{ machines: OwnerMachine[] }>(OWNER_MACHINES_KEY, jsonFetcher, { revalidateOnFocus: false });
  return { machines: data?.machines ?? [], isLoading, isError: error !== undefined, refetch: () => void mutate() };
}
