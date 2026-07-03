'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { useSocketStore } from '@/stores/useSocketStore';
import type { CreditsEventPayload } from '@/lib/websocket';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { SubscriptionTier } from '@/lib/subscription/plans';

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
  /** Outstanding overage owed (non-negative). When > 0, `spendable` is negative. */
  debt: number;
  spendable: number;
  reserved: number;
  subscriptionTier: SubscriptionTier;
}

const fetcher = async (url: string): Promise<CreditBalance> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

/**
 * Pure: fold an authoritative `credits:updated` payload into the cached balance. The
 * payload carries the full server-computed balance except `subscriptionTier` (tier
 * only changes via a Stripe subscription webhook, never via the settle/top-up events
 * that trigger this push) — callers must merge in the previously-cached tier.
 */
export function applyCreditsPayload(
  payload: CreditsEventPayload,
): Omit<CreditBalance, 'subscriptionTier'> {
  return {
    billingEnabled: payload.billingEnabled,
    monthly: payload.monthly,
    topup: payload.topup,
    debt: payload.debt,
    spendable: payload.spendable,
    reserved: payload.reserved,
  };
}

/**
 * Mutate options for applying a socket push. We do NOT revalidate: the payload is the
 * authoritative server balance, so a follow-up GET /api/credits only races it — an
 * in-flight hold created/expired between the emit and the refetch would yield a third,
 * different number and reintroduce the "more → less → more" flicker. The initial fetch
 * and the visibility-change refetch remain the authoritative reads.
 */
export const CREDITS_PUSH_MUTATE_OPTIONS = { revalidate: false } as const;

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

  // Apply live balance pushes. The payload is the authoritative server-computed balance
  // (one push per settle/funding event — the gate no longer pushes when a hold is just
  // placed), so we apply it without revalidating. Revalidating here used to race the
  // payload and produce a third number; see CREDITS_PUSH_MUTATE_OPTIONS.
  useEffect(() => {
    if (!socket) return;

    const handleCreditsUpdated = (payload: CreditsEventPayload) => {
      mutate(
        (prev) => ({ ...applyCreditsPayload(payload), subscriptionTier: prev?.subscriptionTier ?? 'free' }),
        CREDITS_PUSH_MUTATE_OPTIONS,
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
