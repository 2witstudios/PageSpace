'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { SWRConfig, type SWRConfiguration } from 'swr';
import { getBrowserApiClient, type ApiClient } from './client';
import { ApiError } from './errors';

/**
 * Client errors (4xx) get the same answer when asked again, and a 401 has
 * already sent the page to sign-in; only network failures and 5xx retry.
 */
export const shouldRetryOnError = (error: Error): boolean =>
  !(error instanceof ApiError && error.status < 500);

const ApiClientContext = createContext<ApiClient | null>(null);

/**
 * The client the provider loads through, for hooks that write as well as
 * read; the browser's when no provider gave one.
 */
export const useApiClient = (): ApiClient => useContext(ApiClientContext) ?? getBrowserApiClient();

/**
 * SWR for imago: every key is an apps/web API path loaded through the imago
 * client (session cookie, typed errors, sign-in on 401). Mounted once in the
 * root layout, so the whole app shares one cache and identical keys in flight
 * are fetched once. `client` is a seam for tests; the page uses the browser's.
 */
export function ImagoSWRProvider({
  client,
  children,
}: {
  client?: ApiClient;
  children: ReactNode;
}) {
  const value = useMemo<SWRConfiguration>(
    () => ({
      fetcher: (key: string) => (client ?? getBrowserApiClient()).apiFetch(key),
      // SWR calls provider once per SWRConfig mount: one cache for this tree.
      provider: () => new Map(),
      shouldRetryOnError,
    }),
    [client],
  );

  return (
    <ApiClientContext.Provider value={client ?? null}>
      <SWRConfig value={value}>{children}</SWRConfig>
    </ApiClientContext.Provider>
  );
}
