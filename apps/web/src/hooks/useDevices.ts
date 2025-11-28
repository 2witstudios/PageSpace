import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export interface Device {
  id: string;
  platform: 'web' | 'desktop' | 'ios' | 'android';
  deviceName: string | null;
  deviceId: string;
  lastUsedAt: string;
  trustScore: number;
  suspiciousActivityCount: number;
  ipAddress: string | null;
  lastIpAddress: string | null;
  location: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

const fetcher = async (url: string): Promise<Device[]> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch devices');
  }
  return response.json();
};

export function useDevices() {
  const { data, error, mutate } = useSWR<Device[]>(
    '/api/account/devices',
    fetcher,
    {
      refreshInterval: 60000, // Refresh every minute
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  );

  return {
    devices: data,
    isLoading: !error && !data,
    isError: error,
    refetch: mutate,
  };
}
