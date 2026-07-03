import useSWR from 'swr';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';
import type { ToastNotificationLevel } from '@/lib/notifications/toast-eligible-types';

interface ToastPreference {
  level: ToastNotificationLevel;
}

const fetcher = async (url: string): Promise<ToastPreference> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch toast notification preference');
  }
  return response.json();
};

const defaultPreference: ToastPreference = { level: 'all' };

export function useToastPreferences() {
  const { data, isLoading, mutate } = useSWR<ToastPreference>(
    '/api/settings/toast-preferences',
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
    }
  );

  const updateLevel = async (level: ToastNotificationLevel) => {
    const optimisticData: ToastPreference = { level };

    await mutate(
      async () => {
        await patch('/api/settings/toast-preferences', { level });
        return optimisticData;
      },
      {
        optimisticData,
        rollbackOnError: true,
        revalidate: false,
      }
    );
  };

  return {
    level: (data ?? defaultPreference).level,
    isLoading,
    updateLevel,
  };
}
