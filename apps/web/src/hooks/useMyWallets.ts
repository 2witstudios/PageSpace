'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import type { MyWallets } from '@pagespace/lib/services/drive-wallet-service';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import { WALLET_CHANGED_EVENT } from './useConversationSpend';

export type { MyWallets };

const fetcher = async (url: string): Promise<MyWallets> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

/**
 * `GET /api/wallets` (Spec UI-10): everything the person spends from and funds, and their
 * default. Refetched when their balance (`credits:updated`), an org they are in (`org:changed`:
 * seat caps, status) or a drive wallet they can see (`wallet:changed`) changes.
 */
export function useMyWallets(enabled: boolean) {
  const { data, error, isLoading, mutate } = useSWR<MyWallets>(enabled ? '/api/wallets' : null, fetcher, { revalidateOnFocus: false });
  const socket = useSocketStore((state) => state.socket);

  useEffect(() => {
    if (!socket || !enabled) return;
    const refetch = () => void mutate();
    for (const event of ['credits:updated', 'org:changed', WALLET_CHANGED_EVENT]) socket.on(event, refetch);
    return () => {
      for (const event of ['credits:updated', 'org:changed', WALLET_CHANGED_EVENT]) socket.off(event, refetch);
    };
  }, [socket, enabled, mutate]);

  return { wallets: data ?? null, error, isLoading, refresh: mutate };
}
