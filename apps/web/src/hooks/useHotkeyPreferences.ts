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

  // Sync to store when data loads. A binding the store refuses to keep can
  // never fire, so the default takes over immediately — but the row is left in
  // place deliberately. It is the only durable record that the reset happened:
  // the notice lives in an in-memory store, so deleting the row here would make
  // the reset silent for anyone who reloads before opening Keyboard Shortcuts.
  // The row is removed when the user acknowledges the notice or re-binds.
  useEffect(() => {
    if (!data?.preferences) return;
    setUserBindings(data.preferences);
  }, [data, setUserBindings]);

  return {
    preferences: data?.preferences ?? [],
    isLoading,
    error,
    mutate,
  };
}

/**
 * Read the stored preferences without touching the SWR cache.
 *
 * Deliberately not `mutate()`: that writes the response into the cache, which
 * the hook's effect then feeds into the store. A caller checking what is on the
 * server *before* deleting rows would therefore re-arm the reset notice from
 * the very rows it is about to remove — and, because a later payload that omits
 * a row preserves its notice by design, the banner would never clear again.
 */
export async function fetchHotkeyPreferences(): Promise<HotkeyPreference[]> {
  const { preferences } = await fetcher('/api/settings/hotkey-preferences');
  return preferences ?? [];
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
