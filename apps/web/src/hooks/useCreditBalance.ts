'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { useSocketStore } from '@/stores/useSocketStore';
import type { CreditsEventPayload } from '@/lib/websocket';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

/**
 * Client view of `GET /api/credits`. Mirrors the `CreditBalanceSummary` shape from
 * the server (all money fields are whole cents of customer-facing credit value).
 */
export interface CreditBalance {
  billingEnabled: boolean;
  monthly: {
    remaining: number;
    allowance: number;
    periodEnd: string | null;
  };
  topup: {
    remaining: number;
  };
  spendable: number;
  reserved: number;
  /**
   * Per-environment switch: true → show the new credits UI; false → show the legacy
   * daily-quota UI. Constant for the process, so it's preserved across `credits:updated`
   * socket pushes (whose payload carries only the per-user balance, not the mode).
   */
  creditsMode: boolean;
}

const fetcher = async (url: string): Promise<CreditBalance> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

/**
 * Live prepaid AI-credit balance. Reads `/api/credits` once and then updates from
 * `credits:updated` socket events (emitted after a call settles, a refill lands, or
 * a top-up is purchased) rather than polling.
 */
export function useCreditBalance() {
  const connect = useSocketStore((state) => state.connect);
  const socket = useSocketStore((state) => state.socket);

  const { data, error, isLoading, mutate } = useSWR<CreditBalance>(
    '/api/credits',
    fetcher,
    {
      refreshInterval: 0, // rely on Socket.IO for live updates
      revalidateOnFocus: false,
    },
  );

  // Ensure the socket connection is initiated.
  useEffect(() => {
    connect();
  }, [connect]);

  // Apply live balance pushes without a refetch.
  useEffect(() => {
    if (!socket) return;

    const handleCreditsUpdated = (payload: CreditsEventPayload) => {
      mutate(
        (current) => ({
          billingEnabled: payload.billingEnabled,
          monthly: payload.monthly,
          topup: payload.topup,
          spendable: payload.spendable,
          reserved: payload.reserved,
          // Mode is environment-level (not in the socket payload) — keep the value
          // the initial fetch established; default OFF until that resolves.
          creditsMode: current?.creditsMode ?? false,
        }),
        false,
      );
    };

    socket.on('credits:updated', handleCreditsUpdated);
    return () => {
      socket.off('credits:updated', handleCreditsUpdated);
    };
  }, [socket, mutate]);

  // Revalidate when the tab regains focus (covers any missed socket events).
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) mutate();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [mutate]);

  return {
    balance: data,
    isLoading,
    isError: !!error,
    mutate,
  };
}
