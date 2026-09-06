import useSWR from 'swr';

async function capabilityFetcher(url: string): Promise<{ enabled: boolean }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to load dev-preview capability');
  return response.json();
}

/**
 * Whether dev-server preview is turned on for this deployment — server-
 * derived (`DEV_PREVIEW_ENABLED` AND a configured `DEV_PREVIEW_APEX`), never
 * a `NEXT_PUBLIC_*` leak of the flag's mechanics. `undefined` while loading:
 * callers must render NOTHING for anything but `true`, so a dark deployment
 * (the default everywhere) never flashes the affordance before the real
 * answer arrives. Cached process-wide (SWR dedupes identical keys), so every
 * session and environment row asking this shares one request.
 */
export function useDevPreviewCapability(): boolean | undefined {
  const { data } = useSWR<{ enabled: boolean }>('/api/dev-preview/capability', capabilityFetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  return data?.enabled;
}
