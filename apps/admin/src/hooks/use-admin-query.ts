'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export interface AdminQueryState<T> {
  data: T | null;
  /**
   * The URL that produced `data`. Data is kept across URL changes, so this can
   * differ from the current URL; see dataForUrl.
   */
  dataUrl: string | null;
  /** True only while there is no data yet (initial load). */
  isLoading: boolean;
  /** True during any in-flight fetch, including background refreshes. */
  isFetching: boolean;
  /** Non-null when the most recent fetch failed. Stale data stays in `data`. */
  error: string | null;
  refetch: () => void;
}

interface AdminQueryOptions {
  /** Re-fetch on this interval (ms). Skipped while the tab is hidden. */
  refreshInterval?: number;
  enabled?: boolean;
}

/**
 * `state.data` only if it was fetched for `url`. A page that ACTS on the data
 * (a destructive action against a looked-up target) must use this rather than
 * `data`: the hook keeps the previous URL's data while the next one loads, and
 * after the next one fails.
 */
export function dataForUrl<T>(url: string | null, state: Pick<AdminQueryState<T>, 'data' | 'dataUrl'>): T | null {
  return url !== null && state.dataUrl === url ? state.data : null;
}

/**
 * Single data-fetching path for admin pages: fetchWithAuth + loud errors +
 * stale-data-preserving refresh. A failed fetch always surfaces in `error`
 * (never silently rendered as zeros) while previous data stays visible.
 */
export function useAdminQuery<T>(url: string | null, options: AdminQueryOptions = {}): AdminQueryState<T> {
  const { refreshInterval, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasDataRef = useRef(false);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    if (!url || !enabled) return;
    const generation = ++generationRef.current;
    setIsFetching(true);
    try {
      const res = await fetchWithAuth(url);
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      const json = await res.json() as T;
      if (generation !== generationRef.current) return;
      hasDataRef.current = true;
      setData(json);
      setDataUrl(url);
      setError(null);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      if (generation === generationRef.current) setIsFetching(false);
    }
  }, [url, enabled]);

  // On URL/param change keep the previous data visible (isFetching signals the
  // refresh) instead of blanking the page to skeletons; only clear the error.
  useEffect(() => {
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!refreshInterval || !enabled) return;
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, refreshInterval);
    return () => clearInterval(id);
  }, [refreshInterval, enabled, load]);

  return {
    data,
    dataUrl,
    isLoading: !hasDataRef.current && (isFetching || (!error && enabled && !!url)),
    isFetching,
    error,
    refetch: () => void load(),
  };
}
