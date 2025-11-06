'use client';

import useSWR from 'swr';

interface Drive {
  id: string;
  name: string;
}

interface UseUserDrivesResult {
  drives: Drive[];
  isLoading: boolean;
  isError: boolean;
  error: Error | undefined;
}

const fetcher = async (url: string): Promise<Drive[]> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch user drives');
  }
  const data = await res.json();
  return data.drives || [];
};

export function useUserDrives(): UseUserDrivesResult {
  const { data, error, isLoading } = useSWR<Drive[]>('/api/drives', fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });

  return {
    drives: data ?? [],
    isLoading,
    isError: !!error,
    error,
  };
}
