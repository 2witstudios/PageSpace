'use client';

import useSWR from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { useSocketEvent } from '@/realtime/realtime-provider';
import { fetchMembersDirectory } from './members-api';

/** The same member events the roster listens to: an invite, a removal or a role change refreshes the names. */
const MEMBER_EVENTS = ['drive:member_added', 'drive:member_removed', 'drive:member_role_changed'] as const;

type MemberEventPayload = { readonly driveId?: string };

/** The SWR key of the drive's directory; the invite form revalidates it after a send. */
export const membersDirectoryKey = (driveId: string) => ['imago:members-directory', driveId] as const;

/** The drive's names and waiting invites, for the profile and invite panes. `enabled` false loads nothing. */
export const useMembersDirectory = (driveId: string, enabled: boolean) => {
  const client = useApiClient();
  const { data, error, mutate } = useSWR(
    enabled ? membersDirectoryKey(driveId) : null,
    ([, id]) => fetchMembersDirectory(client, id),
  );
  const onMemberEvent = (payload: MemberEventPayload) => {
    if (payload?.driveId === driveId) void mutate();
  };
  useSocketEvent<[MemberEventPayload]>(MEMBER_EVENTS[0], onMemberEvent);
  useSocketEvent<[MemberEventPayload]>(MEMBER_EVENTS[1], onMemberEvent);
  useSocketEvent<[MemberEventPayload]>(MEMBER_EVENTS[2], onMemberEvent);
  return { directory: data, error: error as unknown, retry: () => void mutate() };
};
