import useSWR from 'swr';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';

interface DisplayPreferences {
  showTokenCounts: boolean;
  showCodeToggle: boolean;
  defaultMarkdownMode: boolean;
}

const fetcher = async (url: string): Promise<DisplayPreferences> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch display preferences');
  }
  return response.json();
};

const defaultPreferences: DisplayPreferences = {
  showTokenCounts: false,
  showCodeToggle: false,
  defaultMarkdownMode: false,
};

export function useDisplayPreferences() {
  const { data, error, isLoading, mutate } = useSWR<DisplayPreferences>(
    '/api/settings/display-preferences',
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000, // 1 minute
    }
  );

  const updatePreference = async (
    type: 'SHOW_TOKEN_COUNTS' | 'SHOW_CODE_TOGGLE' | 'DEFAULT_MARKDOWN_MODE',
    enabled: boolean
  ) => {
    // Optimistic update
    const keyMap: Record<string, keyof DisplayPreferences> = {
      'SHOW_TOKEN_COUNTS': 'showTokenCounts',
      'SHOW_CODE_TOGGLE': 'showCodeToggle',
      'DEFAULT_MARKDOWN_MODE': 'defaultMarkdownMode',
    };
    const key = keyMap[type];
    const optimisticData = {
      ...defaultPreferences,
      ...data,
      [key]: enabled,
    };

    await mutate(
      async () => {
        await patch('/api/settings/display-preferences', {
          preferenceType: type,
          enabled,
        });
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
    preferences: data ?? defaultPreferences,
    isLoading,
    error,
    updatePreference,
  };
}
