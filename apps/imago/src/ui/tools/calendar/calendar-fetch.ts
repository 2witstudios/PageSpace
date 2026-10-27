import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';

/** A GET against the web API through the shared authenticated fetch; a non-OK status throws. */
export async function fetchCalendarJson<T>(url: string): Promise<T> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return (await response.json()) as T;
}
