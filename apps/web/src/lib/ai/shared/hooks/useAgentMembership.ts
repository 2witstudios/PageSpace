/**
 * useAgentMembership - Shared, SWR-backed hook for an agent's drive
 * membership (role + custom role) and the drive's available roles.
 *
 * Mirrors useAgentConfig's reasoning: SWR's cache is keyed by URL, so every
 * mounted Settings surface for agents in the SAME drive shares one fetch of
 * `/api/drives/{driveId}/agents/members` and one fetch of
 * `/api/drives/{driveId}/roles`. Without this, each PageAgentSettingsTab
 * instance held its own `useState`-backed snapshot loaded once on mount —
 * two Settings surfaces for the SAME agent (an ordinary scenario: two panes
 * both open to that agent's Settings tab) would drift the moment either one
 * changed the role, since the change only ever touched the mounting
 * instance's own local state (review finding — chatgpt-codex-connector on
 * PR #2299, round 27, thread r3695144705).
 */
import { useState } from 'react';
import useSWR from 'swr';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';

interface AgentMemberRow {
  agentPageId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  customRole: { id: string; name: string; color: string | null } | null;
}

interface AgentMembersResponse {
  agentMembers: AgentMemberRow[];
  currentUserRole: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export interface DriveRole {
  id: string;
  name: string;
  color?: string | null;
}

interface RolesResponse {
  roles: DriveRole[];
}

export interface AgentMembership {
  role: string;
  customRole: { id: string; name: string; color: string | null } | null;
}

function membersKey(driveId: string): string {
  return `/api/drives/${driveId}/agents/members`;
}

function rolesKey(driveId: string): string {
  return `/api/drives/${driveId}/roles`;
}

interface UseAgentMembershipResult {
  /** `undefined` while loading, `null` if the agent has no explicit role. */
  membership: AgentMembership | null | undefined;
  membershipUserRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  driveRoles: DriveRole[];
  updateRole: (value: string) => Promise<void>;
  isSaving: boolean;
}

export function useAgentMembership(driveId: string, pageId: string): UseAgentMembershipResult {
  const [isSaving, setIsSaving] = useState(false);

  const { data: membersData, mutate: mutateMembers } = useSWR<AgentMembersResponse>(
    membersKey(driveId),
    async (url) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error('Failed to load agent members');
      return response.json();
    },
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );

  const { data: rolesData } = useSWR<RolesResponse>(
    rolesKey(driveId),
    async (url) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error('Failed to load drive roles');
      return response.json();
    },
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );

  const entry = membersData?.agentMembers.find((m) => m.agentPageId === pageId);
  const membership: AgentMembership | null | undefined =
    membersData === undefined ? undefined : entry ? { role: entry.role, customRole: entry.customRole } : null;

  const updateRole = async (value: string) => {
    setIsSaving(true);
    try {
      const body: { role: 'MEMBER' | 'ADMIN'; customRoleId: string | null } =
        value === 'ADMIN'
          ? { role: 'ADMIN', customRoleId: null }
          : value === 'MEMBER'
          ? { role: 'MEMBER', customRoleId: null }
          : { role: 'MEMBER', customRoleId: value };
      await patch(`/api/drives/${driveId}/agents/${pageId}`, body);
      // Revalidate the SHARED members cache (rather than a local optimistic
      // merge) so every mounted Settings surface for this agent — not just
      // the one that made the change — sees the new role.
      await mutateMembers();
    } finally {
      setIsSaving(false);
    }
  };

  return {
    membership,
    membershipUserRole: membersData?.currentUserRole ?? 'MEMBER',
    driveRoles: rolesData?.roles ?? [],
    updateRole,
    isSaving,
  };
}
