'use client';

import { useCallback, useEffect, useRef } from 'react';
import useSWR from 'swr';
import type { SurfaceChoice, SurfaceDecision } from '@pagespace/lib/billing/spend-surface';
import { fetchWithAuth, put } from '@/retained/lib/auth/auth-fetch';
import { useSocketStore } from '@/retained/stores/useSocketStore';

/** `GET /api/wallets/conversations/[id]` (Spec SPEND-2, SPEND-3): the choice, the options, the gate's preview. */
export interface ConversationSpend {
  conversationId: string;
  driveId: string | null;
  chosenWalletId: string | null;
  options: SurfaceChoice[];
  resolved: SurfaceDecision;
}

/** The realtime event a drive wallet's viewers hear (lib realtime/org-wallet-events; payloads carry no amounts). */
export const WALLET_CHANGED_EVENT = 'wallet:changed';
/** JOURNEYS-3: this person changed a spend preference elsewhere — conversation source, default, absolute switch. */
export const SPEND_PREFERENCES_EVENT = 'spend:preferences';

export function conversationSpendKey(conversationId: string | null, driveId: string | null, isGlobal: boolean): string | null {
  if (!conversationId) return null;
  const base = `/api/wallets/conversations/${encodeURIComponent(conversationId)}`;
  return isGlobal && driveId ? `${base}?driveId=${encodeURIComponent(driveId)}` : base;
}

/** A conversation the server has not stored yet is pending: only a global draft may preview its drive. */
const fetcher = async (url: string): Promise<ConversationSpend | null> => {
  const response = await fetchWithAuth(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

/** How often, and how many times after the first read, a conversation not stored yet is asked again (SPEND-2). */
export const PENDING_CONVERSATION_RETRY_MS = 1_000;
export const PENDING_CONVERSATION_RETRY_LIMIT = 10;

/**
 * SPEND-2: a new conversation in the right sidebar or the dashboard assistant gets its id before its
 * row is saved (the create runs in the background), so the first read can 404. That answer is not
 * final: ask again shortly, a bounded number of times, so the strip shows the source as soon as the
 * row exists. 0 stops: after a real read, or once the limit is spent (the conversation was never
 * saved; a wallet or credits event still refetches it).
 */
export function pendingConversationRetryMs(misses: number): number {
  // `misses` counts the 404s so far, the first read's included: ask again until LIMIT retries have also missed.
  return misses > 0 && misses <= PENDING_CONVERSATION_RETRY_LIMIT ? PENDING_CONVERSATION_RETRY_MS : 0;
}

/**
 * The spend source of one conversation, kept current: refetched when its drive's wallet changes
 * (`wallet:changed`) or the person's own balance does (`credits:updated`), never polled. `choose` is the only writer of the choice (PUT);
 * it persists for the conversation (SPEND-3) and throws the route's ApiRequestError on refusal.
 * A missing global draft previews its drive without writing; only its explicit choice
 * materializes it, with the source stored before any first-message gate can read the row.
 */
export function useConversationSpend(conversationId: string | null, options: { driveId: string | null; isGlobal: boolean }) {
  const key = conversationSpendKey(conversationId, options.driveId, options.isGlobal);
  // 404s in a row for this key: while it is not stored yet, the read is retried (pendingConversationRetryMs).
  const misses = useRef<{ key: string | null; count: number }>({ key: null, count: 0 });
  const countingFetcher = useCallback(async (url: string) => {
    const read = await fetcher(url);
    misses.current = { key: url, count: read === null ? (misses.current.key === url ? misses.current.count : 0) + 1 : 0 };
    return read;
  }, []);
  const { data, error, isLoading, mutate } = useSWR<ConversationSpend | null>(key, countingFetcher, {
    refreshInterval: (latest) => (latest === null && misses.current.key === key ? pendingConversationRetryMs(misses.current.count) : 0),
    dedupingInterval: PENDING_CONVERSATION_RETRY_MS / 2,
    revalidateOnFocus: false,
  });
  const isPending = data === null && !error;
  const { spend: preview } = useDriveSpend(isPending && options.isGlobal ? options.driveId : null);
  const spend = data ?? (isPending && options.isGlobal && preview && conversationId
    ? { ...preview, conversationId, chosenWalletId: null }
    : null);
  const socket = useSocketStore((state) => state.socket);
  const spendDriveId = spend?.driveId ?? null;

  useEffect(() => {
    if (!socket || !key) return;
    const onWallet = (payload: { driveId?: string }) => {
      if (payload?.driveId && payload.driveId === spendDriveId) void mutate();
    };
    const onCredits = () => void mutate();
    // JOURNEYS-3: another window of this person changed a spend preference — the displayed
    // source must re-resolve so it never disagrees with the next send's wallet.
    const onPreferences = () => void mutate();
    socket.on(WALLET_CHANGED_EVENT, onWallet);
    socket.on('credits:updated', onCredits);
    socket.on(SPEND_PREFERENCES_EVENT, onPreferences);
    return () => {
      socket.off(WALLET_CHANGED_EVENT, onWallet);
      socket.off('credits:updated', onCredits);
      socket.off(SPEND_PREFERENCES_EVENT, onPreferences);
    };
  }, [socket, key, spendDriveId, mutate]);

  const choose = useCallback(
    async (walletId: string | null) => {
      if (!key) return;
      const next = await put<ConversationSpend>(key, { walletId, ...(isPending && options.isGlobal && { createGlobalDraft: true }) });
      await mutate(next, { revalidate: false });
    },
    [key, mutate, isPending, options.isGlobal],
  );

  return { spend, isPending, error, isLoading, choose, refresh: mutate };
}

/** `GET /api/wallets/drives/[driveId]` (Spec SPEND-2): a drive's options and what a new conversation there would spend. */
export interface DriveSpend {
  driveId: string;
  options: SurfaceChoice[];
  resolved: SurfaceDecision;
}

export function driveSpendKey(driveId: string | null): string | null {
  return driveId ? `/api/wallets/drives/${encodeURIComponent(driveId)}` : null;
}

const driveFetcher = async (url: string): Promise<DriveSpend | null> => {
  const response = await fetchWithAuth(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

/**
 * SPEND-2: the source of the drive the person is in while no conversation is in view, so the
 * header chip still names it there. Read only (a choice is per conversation, SPEND-3); refetched
 * on the drive's `wallet:changed` and on `credits:updated`, never polled.
 */
export function useDriveSpend(driveId: string | null) {
  const key = driveSpendKey(driveId);
  const { data, error, isLoading, mutate } = useSWR<DriveSpend | null>(key, driveFetcher, { revalidateOnFocus: false });
  const socket = useSocketStore((state) => state.socket);

  useEffect(() => {
    if (!socket || !key) return;
    const onWallet = (payload: { driveId?: string }) => {
      if (payload?.driveId && payload.driveId === driveId) void mutate();
    };
    const onCredits = () => void mutate();
    const onPreferences = () => void mutate();
    socket.on(WALLET_CHANGED_EVENT, onWallet);
    socket.on('credits:updated', onCredits);
    socket.on(SPEND_PREFERENCES_EVENT, onPreferences);
    return () => {
      socket.off(WALLET_CHANGED_EVENT, onWallet);
      socket.off('credits:updated', onCredits);
      socket.off(SPEND_PREFERENCES_EVENT, onPreferences);
    };
  }, [socket, key, driveId, mutate]);

  // JOURNEYS-2: send readiness reads this preview too — it exposes its state and a retry.
  return { spend: data ?? null, isPending: data === undefined && !error, error, isLoading, refresh: mutate };
}
