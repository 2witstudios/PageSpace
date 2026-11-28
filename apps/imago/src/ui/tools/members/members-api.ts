// The roster's routes apps/web already has, through imago's API client (the session
// cookie on each request). A drive's invite links are the owner's and admins' to see:
// for anyone else the route refuses, and the count stays undefined.

import type { ApiClient } from '@/api/client';
import { ApiError } from '@/api/errors';
import { partitionMembers, type RosterCounts } from './members-roster';

const segment = encodeURIComponent;

export const membersPaths = {
  members: (driveId: string) => `/api/drives/${segment(driveId)}/members`,
  agents: (driveId: string) => `/api/drives/${segment(driveId)}/agents/members`,
  apps: (driveId: string) => `/api/drives/${segment(driveId)}/apps/members`,
  shareLinks: (driveId: string) => `/api/drives/${segment(driveId)}/share-links`,
};

type MembersResponse = { readonly members: readonly { readonly role: string }[]; readonly pendingInvites?: readonly unknown[] };
type ListResponse = { readonly agentMembers?: readonly unknown[]; readonly appMembers?: readonly unknown[] };
type ShareLinksResponse = { readonly links: readonly unknown[] };

/** A drive's live counts for the Members pane. A refusal for the invite links alone is not a failure. */
export async function fetchMembersRoster(client: ApiClient, driveId: string): Promise<RosterCounts> {
  const [members, agents, apps, links] = await Promise.all([
    client.apiFetch<MembersResponse>(membersPaths.members(driveId)),
    client.apiFetch<ListResponse>(membersPaths.agents(driveId)),
    client.apiFetch<ListResponse>(membersPaths.apps(driveId)),
    client.apiFetch<ShareLinksResponse>(membersPaths.shareLinks(driveId)).then(
      (response) => response.links.length,
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 403) return undefined;
        throw error;
      },
    ),
  ]);
  const { people, guests } = partitionMembers(members.members);
  return {
    people: people.length,
    guests: guests.length,
    agents: agents.agentMembers?.length ?? 0,
    apps: apps.appMembers?.length ?? 0,
    pendingInvites: members.pendingInvites?.length ?? 0,
    inviteLinks: links,
  };
}

/** A drive member as the Members panes name them. */
export type DirectoryPerson = {
  readonly userId: string;
  readonly name: string;
  readonly role: string;
};

/** An invite waiting on its invitee (drives/[driveId]/members, pendingInvites). */
export type PendingInvite = {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly customRoleName: string | null;
  readonly expiresAt: string | null;
};

/** The names and waiting invites the profile and invite panes list. */
export type MembersDirectory = {
  readonly people: readonly DirectoryPerson[];
  readonly guests: readonly DirectoryPerson[];
  readonly agents: readonly string[];
  readonly pendingInvites: readonly PendingInvite[];
};

type DirectoryMember = {
  readonly role: string;
  readonly userId: string;
  readonly user: { readonly email: string; readonly name?: string };
  readonly profile?: { readonly displayName?: string };
};
type DirectoryResponse = {
  readonly members: readonly DirectoryMember[];
  readonly pendingInvites?: readonly PendingInvite[];
};
type AgentNamesResponse = { readonly agentMembers?: readonly { readonly title: string | null }[] };

/** The member names and waiting invites. Pending invites are the owner's and admins' to see: for anyone else the list is empty. */
export async function fetchMembersDirectory(client: ApiClient, driveId: string): Promise<MembersDirectory> {
  const [members, agents] = await Promise.all([
    client.apiFetch<DirectoryResponse>(membersPaths.members(driveId)),
    client.apiFetch<AgentNamesResponse>(membersPaths.agents(driveId)),
  ]);
  const named = (member: DirectoryMember): DirectoryPerson => ({
    userId: member.userId,
    name: member.profile?.displayName || member.user.name || member.user.email,
    role: member.role,
  });
  const { people, guests } = partitionMembers(members.members);
  return {
    people: people.map(named),
    guests: guests.map(named),
    agents: (agents.agentMembers ?? []).map((agent) => agent.title ?? 'Unnamed Agent'),
    pendingInvites: members.pendingInvites ?? [],
  };
}
