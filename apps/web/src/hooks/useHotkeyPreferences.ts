import useSWR from 'swr';
import { useEffect, useRef } from 'react';
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
  /** Rows already sent for cleanup, so a stale payload cannot re-trigger one. */
  const cleanedUp = useRef<Set<string>>(new Set());

  // Sync to store when data loads
  useEffect(() => {
    if (!data?.preferences) return;

    setUserBindings(data.preferences);

    // Anything in this payload the store refused to keep can never fire — a
    // bare key, or an Alt binding holding a macOS-composed character. Drop the
    // row so the default stands and this resolves itself once.
    const { userBindings } = useHotkeyStore.getState();

    for (const { hotkeyId } of data.preferences) {
      if (userBindings.has(hotkeyId) || cleanedUp.current.has(hotkeyId)) continue;

      // Remember the attempt before awaiting: a stale row that survives a failed
      // delete would otherwise be retried on every revalidation.
      cleanedUp.current.add(hotkeyId);
      void deleteHotkeyPreference(hotkeyId).catch(() => {
        // Best-effort cleanup — the store already fell back to the default.
      });
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

export async function deleteHotkeyPreference(hotkeyId: string): Promise<void> {
  const res = await fetchWithAuth('/api/settings/hotkey-preferences', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ hotkeyId }),
  });

  if (!res.ok) {
    throw new Error('Failed to delete hotkey preference');
  }

  useHotkeyStore.getState().removeBinding(hotkeyId);
}
