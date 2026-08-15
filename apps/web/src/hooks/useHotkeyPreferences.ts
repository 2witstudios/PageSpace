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
    if (!data?.preferences) return;

    setUserBindings(data.preferences);

    // Bindings written by the old capture code no longer match what the runtime
    // compares against. The store has already rewritten the salvageable ones and
    // dropped the rest; persist both outcomes so this happens only once.
    const { userBindings, migratedBindings } = useHotkeyStore.getState();

    for (const { hotkeyId, binding } of migratedBindings) {
      void updateHotkeyPreference(hotkeyId, binding).catch(() => {
        // Best-effort — the store is already using the rewritten binding.
      });
    }

    // Anything in this payload the store refused to keep was unmatchable. Derive
    // it from the payload rather than the accumulated notice list, so a later
    // revalidation does not re-delete rows that are already gone.
    for (const { hotkeyId } of data.preferences) {
      if (!userBindings.has(hotkeyId)) {
        void deleteHotkeyPreference(hotkeyId).catch(() => {
          // Best-effort cleanup — the store already fell back to the default.
        });
      }
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
