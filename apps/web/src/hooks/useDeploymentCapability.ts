import useSWR from 'swr';

async function capabilityFetcher(url: string): Promise<{ enabled: boolean }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load capability (${url})`);
  return response.json();
}

/**
 * Whether a server-gated feature is turned on for this deployment — the ONE
 * shape every dark-launched surface uses (app hosting, dev-server preview):
 * a `GET <path>` answering `{ enabled }`, server-derived, never a
 * `NEXT_PUBLIC_*` leak of the flag's mechanics. `undefined` while loading —
 * callers must NOT default that to `true`, or the surface would flash
 * visible before the real (usually `false`) answer arrives. Cached
 * process-wide (SWR dedupes identical keys), so every row asking shares one
 * request rather than one per row.
 */
export function useDeploymentCapability(path: `/api/${string}/capability`): boolean | undefined {
  const { data } = useSWR<{ enabled: boolean }>(path, capabilityFetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  return data?.enabled;
}
