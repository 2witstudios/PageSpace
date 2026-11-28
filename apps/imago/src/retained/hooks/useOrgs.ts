'use client';

/**
 * Org data for the org surfaces (UI-1, UI-2, UI-7).
 */
import { useEffect, useRef } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import type { OrgChangedPayload, WalletChangedPayload } from '@pagespace/lib/realtime/org-wallet-events';
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';
import { useSocketStore } from '@/retained/stores/useSocketStore';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import {
  orgFetcher,
  orgKeys,
  type GuestApproval,
  type OrgDetail,
  type OrgDriveDirectoryEntry,
  type OrgInvitation,
  type OrgMember,
  type OrgRole,
  type OrgSeats,
  type OrgSummary,
} from '@/retained/lib/orgs/org-api';
import { orgChangeRefreshes, walletChangeRefreshes } from '@/retained/lib/orgs/org-realtime';
import { useMyOrganizations } from './useMyOrganizations';
import type { OrgHubCounts } from '@/retained/lib/orgs/org-hub';

const SWR_OPTIONS = { revalidateOnFocus: false, isPaused: () => useEditingStore.getState().isAnyEditing() };

/** My organizations for the org surfaces: the same GET /api/orgs cache entry the picker reads (useMyOrganizations). */
export function useMyOrgs(): { orgs: OrgSummary[] | undefined; error: unknown; isLoading: boolean; mutate: () => Promise<unknown> } {
  const { loaded, error, isLoading, refresh } = useMyOrganizations();
  return { orgs: loaded, error, isLoading: isLoading, mutate: refresh };
}

export function useOrg(orgId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<OrgDetail>(
    orgId ? orgKeys.detail(orgId) : null,
    orgFetcher,
    SWR_OPTIONS,
  );
  return { org: data, error, isLoading: !!orgId && isLoading, mutate };
}

/** Admin-only reads: each key is null (no request) unless the viewer manages the org. */
function useManagerSWR<T>(key: string | null, role: OrgRole | undefined) {
  return useSWR<T>(key && orgRoleAtLeast(role, 'ADMIN') ? key : null, orgFetcher, SWR_OPTIONS);
}

export function useOrgHubCounts(orgId: string, role: OrgRole | undefined): OrgHubCounts {
  const members = useManagerSWR<{ members: OrgMember[] }>(orgKeys.members(orgId), role);
  const invitations = useManagerSWR<{ invitations: OrgInvitation[] }>(orgKeys.invitations(orgId), role);
  const drives = useManagerSWR<{ drives: unknown[] }>(orgKeys.drives(orgId), role);
  const approvals = useManagerSWR<{ total: number; items: GuestApproval[] }>(orgKeys.guestApprovals(orgId), role);
  const automations = useManagerSWR<{ automations: unknown[] }>(orgKeys.automations(orgId), role);
  const guests = useManagerSWR<{ guests: unknown[] }>(orgKeys.guests(orgId), role);
  const now = Date.now();
  return {
    members: members.data?.members.length,
    pendingInvites: invitations.data?.invitations.filter((i) => !i.acceptedAt && Date.parse(i.expiresAt) > now).length,
    guests: guests.data?.guests.length,
    drives: drives.data?.drives.length,
    guestApprovals: approvals.data?.total,
    ownerLeftAutomations: automations.data?.automations.length,
  };
}

/**
 * The org Drives directory (DRV-6) for any member: what they can open or ask to join. The server
 * lists to each member only what they may see there (decideDriveDirectoryEntry).
 */
export function useOrgDriveDirectory(orgId: string | undefined) {
  return useSWR<{ drives: OrgDriveDirectoryEntry[] }>(orgId ? orgKeys.drives(orgId) : null, orgFetcher, SWR_OPTIONS);
}

/** A read for Owner and Admins (the org settings pages); null key, no request, for anyone else. */
export function useOrgAdminRead<T>(key: string | null, role: OrgRole | undefined) {
  return useManagerSWR<T>(key, role);
}

export function useOrgSeats(orgId: string, role: OrgRole | undefined, enabled = true) {
  return useManagerSWR<{ seats: OrgSeats }>(enabled ? orgKeys.seats(orgId) : null, role);
}

/**
 * X-4: refetch org projections when `org:changed` arrives on the viewer's notifications room. While
 * someone is editing, the refresh is deferred (not dropped) until editing ends, so a form being
 * typed into is never clobbered.
 */
export function useOrgRealtime(viewedOrgId?: string) {
  const connect = useSocketStore((state) => state.connect);
  const socket = useSocketStore((state) => state.socket);
  const { mutate } = useSWRConfig();
  const deferred = useRef<OrgChangedPayload[]>([]);

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    if (!socket) return;
    const refresh = (payload: OrgChangedPayload) => void mutate(orgChangeRefreshes(payload, viewedOrgId));
    const onChanged = (payload: OrgChangedPayload) => {
      if (useEditingStore.getState().isAnyEditing()) {
        deferred.current.push(payload);
        return;
      }
      refresh(payload);
    };
    const unsubscribe = useEditingStore.subscribe((state) => {
      if (deferred.current.length === 0 || state.isAnyEditing()) return;
      const pending = deferred.current;
      deferred.current = [];
      pending.forEach(refresh);
    });
    socket.on('org:changed', onChanged);
    return () => {
      socket.off('org:changed', onChanged);
      unsubscribe();
    };
  }, [socket, mutate, viewedOrgId]);
}

/**
 * X-4: refetch the pool split and seat caps when `wallet:changed` arrives for a drive this page shows. The
 * server sends it to `drive:<id>:wallet`, joined on `join_drive` by people with a wallet view (org Owner and
 * Admins on org drives). Rooms are shared by every hook on the socket, so this never leaves one.
 */
export function useOrgWalletRealtime(orgId: string, driveIds: readonly string[]) {
  const socket = useSocketStore((state) => state.socket);
  const { mutate } = useSWRConfig();
  const deferred = useRef<((key: unknown) => boolean) | null>(null);
  const key = driveIds.join(',');

  useEffect(() => {
    if (!socket || driveIds.length === 0) return;
    for (const driveId of driveIds) socket.emit('join_drive', driveId);
    const onChanged = (payload: WalletChangedPayload) => {
      const matcher = walletChangeRefreshes(payload, orgId, driveIds);
      if (useEditingStore.getState().isAnyEditing()) {
        deferred.current = matcher;
        return;
      }
      void mutate(matcher);
    };
    const unsubscribe = useEditingStore.subscribe((state) => {
      if (!deferred.current || state.isAnyEditing()) return;
      const replay = deferred.current;
      deferred.current = null;
      void mutate(replay);
    });
    socket.on('wallet:changed', onChanged);
    return () => {
      socket.off('wallet:changed', onChanged);
      unsubscribe();
    };
    // driveIds is keyed by its joined value so a new array with the same drives does not re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, mutate, orgId, key]);
}
