'use client';

/**
 * Org data for the org surfaces (UI-1, UI-2, UI-7). Every hook is dark while ORGS_ENABLED is false:
 * it fetches nothing and returns nothing, so no org UI shows while orgs are dark.
 */
import { useEffect, useRef } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import type { OrgChangedPayload } from '@pagespace/lib/realtime/org-wallet-events';
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';
import { useSocketStore } from '@/stores/useSocketStore';
import { useEditingStore } from '@/stores/useEditingStore';
import {
  orgFetcher,
  orgKeys,
  type GuestApproval,
  type OrgDetail,
  type OrgInvitation,
  type OrgMember,
  type OrgRole,
  type OrgSeats,
  type OrgSummary,
} from '@/lib/orgs/org-api';
import { orgChangeRefreshes } from '@/lib/orgs/org-realtime';
import type { OrgHubCounts } from '@/lib/orgs/org-hub';

const SWR_OPTIONS = { revalidateOnFocus: false, isPaused: () => useEditingStore.getState().isAnyEditing() };

export function useMyOrgs() {
  const { data, error, isLoading, mutate } = useSWR<{ organizations: OrgSummary[] }>(
    ORGS_ENABLED ? orgKeys.mine() : null,
    orgFetcher,
    SWR_OPTIONS,
  );
  return { orgs: data?.organizations, error, isLoading: ORGS_ENABLED && isLoading, mutate };
}

export function useOrg(orgId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<OrgDetail>(
    ORGS_ENABLED && orgId ? orgKeys.detail(orgId) : null,
    orgFetcher,
    SWR_OPTIONS,
  );
  return { org: data, error, isLoading: ORGS_ENABLED && !!orgId && isLoading, mutate };
}

/** Admin-only reads: each key is null (no request) unless the viewer manages the org. */
function useManagerSWR<T>(key: string | null, role: OrgRole | undefined) {
  return useSWR<T>(ORGS_ENABLED && key && orgRoleAtLeast(role, 'ADMIN') ? key : null, orgFetcher, SWR_OPTIONS);
}

export function useOrgHubCounts(orgId: string, role: OrgRole | undefined): OrgHubCounts {
  const members = useManagerSWR<{ members: OrgMember[] }>(orgKeys.members(orgId), role);
  const invitations = useManagerSWR<{ invitations: OrgInvitation[] }>(orgKeys.invitations(orgId), role);
  const drives = useManagerSWR<{ drives: unknown[] }>(orgKeys.drives(orgId), role);
  const approvals = useManagerSWR<{ total: number; items: GuestApproval[] }>(orgKeys.guestApprovals(orgId), role);
  const automations = useManagerSWR<{ items: unknown[] }>(orgKeys.automations(orgId), role);
  const guests = useManagerSWR<{ guests: unknown[] }>(orgKeys.guests(orgId), role);
  const now = Date.now();
  return {
    members: members.data?.members.length,
    pendingInvites: invitations.data?.invitations.filter((i) => !i.acceptedAt && Date.parse(i.expiresAt) > now).length,
    guests: guests.data?.guests.length,
    drives: drives.data?.drives.length,
    guestApprovals: approvals.data?.total,
    ownerLeftAutomations: automations.data?.items.length,
  };
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
    if (ORGS_ENABLED) connect();
  }, [connect]);

  useEffect(() => {
    if (!ORGS_ENABLED || !socket) return;
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
