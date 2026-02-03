import useSWR from 'swr';
import { useEffect } from 'react';
import { useHotkeyStore } from '@/stores/useHotkeyStore';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface HotkeyPreference {
  hotkeyId: string;
  binding: string;
}

interface HotkeyPreferencesResponse {
  preferences: HotkeyPreference[];
}

const fetcher = async (url: string): Promise<HotkeyPreferencesResponse> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch hotkey preferences');
  return res.json();
};

export function useHotkeyPreferences() {
  const { data, error, isLoading, mutate } = useSWR<HotkeyPreferencesResponse>(
    '/api/settings/hotkey-preferences',
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    }
  );

  const setUserBindings = useHotkeyStore((state) => state.setUserBindings);

  // Sync to store when data loads
  useEffect(() => {
    if (data?.preferences) {
      setUserBindings(data.preferences);
    }
  }, [data, setUserBindings]);

  return {
    preferences: data?.preferences ?? [],
    isLoading,
    error,
    mutate,
  };
}

export async function updateHotkeyPreference(hotkeyId: string, binding: string): Promise<void> {
  const res = await fetchWithAuth('/api/settings/hotkey-preferences', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ hotkeyId, binding }),
  });

  if (!res.ok) {
    let errorMessage = 'Failed to update hotkey preference';
    try {
      const errorBody = await res.json();
      errorMessage = errorBody.error || errorBody.message || errorMessage;
    } catch {
      const textBody = await res.text().catch(() => '');
      errorMessage = textBody || res.statusText || errorMessage;
    }
    throw new Error(errorMessage);
  }

  // Update local store
  useHotkeyStore.getState().updateBinding(hotkeyId, binding);
}
