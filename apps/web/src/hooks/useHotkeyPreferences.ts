import useSWR from 'swr';
import { useEffect } from 'react';
import { useHotkeyStore } from '@/stores/useHotkeyStore';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { isUsableBinding } from '@/lib/hotkeys/binding';

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
  // place deliberately. It is the durable record that the reset happened, and
  // the Settings notice is derived from it (`unusablePreferences`), so deleting
  // it here would make the reset silent for anyone who reloads before opening
  // Keyboard Shortcuts. The row goes when the user acknowledges or re-binds.
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
 * The stored preferences that cannot fire, and so have fallen back to their
 * default. This is the whole of the "these shortcuts were reset" notice.
 *
 * Derived from the payload rather than remembered, which is only possible
 * because the rows are deliberately not deleted on load — the row *is* the
 * record that the reset happened, so it outlives the tab for free. The bugs
 * this notice had came from keeping a second copy of that fact in memory and
 * trying to keep the two in step: it went stale when another tab re-bound the
 * shortcut, and it re-armed itself from a read taken before its own deletes.
 * Neither is expressible against a value derived on every render.
 *
 * It does not make the notice user-scoped on its own — the payload it derives
 * from is an SWR cache entry, which outlives a sign-out in the same document.
 * That is why `logout` clears the entry as well as the store.
 */
export function unusablePreferences(preferences: HotkeyPreference[]): HotkeyPreference[] {
  return preferences.filter(({ binding }) => binding !== '' && !isUsableBinding(binding));
}

/**
 * Read the stored preferences without touching the SWR cache.
 *
 * Deliberately not `mutate()`: that publishes the response to every consumer,
 * so a caller checking what is on the server *before* deleting rows would first
 * repaint the page from the very rows it is about to remove.
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

/**
 * Remove a stored override. Resolves to whether the row was actually removed.
 *
 * `ifBinding` makes the delete conditional on the row still holding that exact
 * value, which closes the window between deciding a row is unusable and saying
 * so: another tab can save a real shortcut in between, and an unconditional
 * delete would discard it. Callers acting on the user's direct instruction for
 * one shortcut — the Reset button — omit it.
 */
export async function deleteHotkeyPreference(
  hotkeyId: string,
  ifBinding?: string
): Promise<boolean> {
  const res = await fetchWithAuth('/api/settings/hotkey-preferences', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(ifBinding === undefined ? { hotkeyId } : { hotkeyId, ifBinding }),
  });

  if (!res.ok) {
    throw new Error('Failed to delete hotkey preference');
  }

  // Says whether the row actually went. A conditional delete that matched
  // nothing is a success — the row simply holds something newer — and callers
  // must not treat it as one they can erase from what they are showing.
  const body = await res.json().catch(() => null);
  const deleted = body?.deleted === undefined ? true : body.deleted > 0;

  // Gate the local removal on the row count only when the caller asked for a
  // conditional delete: there, a miss means the row holds something newer and
  // erasing it locally would blank a live shortcut. An unconditional delete is
  // the user asking for no override at all, and that end state holds whether
  // or not a row happened to still be there.
  if (ifBinding === undefined || deleted) {
    useHotkeyStore.getState().removeBinding(hotkeyId);
  }

  return deleted;
}
