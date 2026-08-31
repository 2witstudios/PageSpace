import useSWR from 'swr';

async function capabilityFetcher(url: string): Promise<{ enabled: boolean }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to load app-hosting capability');
  return response.json();
}

/**
 * Whether app hosting is turned on for this deployment. `undefined` while
 * loading — callers must NOT default that to `true`, or the publish surface
 * would flash visible before the real (usually `false`) answer arrives.
 * Cached process-wide (SWR dedupes identical keys), so every environment row
 * asking this shares one request rather than one per row.
 */
export function useAppHostingCapability(): boolean | undefined {
  const { data } = useSWR<{ enabled: boolean }>('/api/app-hosting/capability', capabilityFetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  return data?.enabled;
}
