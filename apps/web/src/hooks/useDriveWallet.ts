'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import type { DriveWalletView } from '@pagespace/lib/billing/wallet-views';
import type { WalletAction, WalletViewer } from '@pagespace/lib/permissions/wallet-access';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import { WALLET_CHANGED_EVENT } from './useConversationSpend';

/** `GET /api/drives/[driveId]/wallet` (Spec SPEND-9, SPEND-10, UI-9): the view this person may see. */
export interface DriveWalletRead {
  viewer: Exclude<WalletViewer, 'none'>;
  actions: WalletAction[];
  /** Null when the drive has no wallet yet. */
  wallet: DriveWalletView | null;
}

export const driveWalletKey = (driveId: string | null): string | null =>
  ORGS_ENABLED && driveId ? `/api/drives/${encodeURIComponent(driveId)}/wallet` : null;

/** No access (or orgs dark on the server) is a 404: no wallet view, not an error. */
const fetcher = async (url: string): Promise<DriveWalletRead | null> => {
  const response = await fetchWithAuth(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

/**
 * A drive's wallet as the person may see it, refetched on `wallet:changed` for that drive (X-4:
 * payloads carry no amounts, so the client refetches its own projection). Dark while orgs are off.
 */
export function useDriveWallet(driveId: string | null) {
  const key = driveWalletKey(driveId);
  const { data, error, isLoading, mutate } = useSWR<DriveWalletRead | null>(key, fetcher, {
    refreshInterval: 0,
    revalidateOnFocus: false,
  });
  const socket = useSocketStore((state) => state.socket);

  useEffect(() => {
    if (!socket || !key || !driveId) return;
    const onWallet = (payload: { driveId?: string }) => {
      if (payload?.driveId === driveId) void mutate();
    };
    socket.on(WALLET_CHANGED_EVENT, onWallet);
    return () => {
      socket.off(WALLET_CHANGED_EVENT, onWallet);
    };
  }, [socket, key, driveId, mutate]);

  return {
    read: data ?? null,
    wallet: data?.wallet ?? null,
    viewer: data?.viewer ?? null,
    actions: data?.actions ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
