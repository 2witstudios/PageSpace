'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { useSocketStore } from '@/retained/stores/useSocketStore';
import type { CreditsEventPayload } from '@/retained-adapters/ui-contracts';
import type { SubscriptionTier } from '@/retained/lib/subscription/plans';

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

  // No fetcher of its own (Imago maintained edit): ImagoSWRProvider's, the one every '/api/credits'
  // reader shares. It throws imago's ApiError, so a 4xx is not retried and a 401 goes to sign-in.
  const { data, error, isLoading, mutate } = useSWR<CreditBalance>(
    '/api/credits',
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
        // Skip the merge (leave the cache as-is) if the initial fetch hasn't
        // resolved yet — defaulting subscriptionTier to 'free' here would briefly
        // mis-show the upgrade CTA to a paid user. This also means the balance
        // fields in this particular push are deferred rather than applied early,
        // but that's fine: the initial GET is already in flight in this window
        // and lands within moments regardless of what this handler does.
        (prev) => (prev ? { ...applyCreditsPayload(payload), subscriptionTier: prev.subscriptionTier } : prev),
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
