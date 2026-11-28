'use client';

import useSWR from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { useSocketEvent } from '@/realtime/realtime-provider';
import { fetchMembersRoster } from './members-api';

/** The SWR key of the drive's roster counts; the invite form revalidates it after a send. */
export const membersRosterKey = (driveId: string) => ['imago:members-roster', driveId] as const;

/** The member events apps/web broadcasts for a drive (retained DriveMembers listens to the same three). */
const MEMBER_EVENTS = ['drive:member_added', 'drive:member_removed', 'drive:member_role_changed'] as const;

type MemberEventPayload = { readonly driveId?: string };

/**
 * The drive's live counts (`enabled` false loads nothing). A member event for this drive asks the server again, so the counts
 * follow an invite, a removal or a role change without a reload.
 */
export const useMembersRoster = (driveId: string, enabled = true) => {
  const client = useApiClient();
  const { data, error, mutate } = useSWR(
    enabled ? membersRosterKey(driveId) : null,
    ([, id]) => fetchMembersRoster(client, id),
  );
  const onMemberEvent = (payload: MemberEventPayload) => {
    if (payload?.driveId === driveId) void mutate();
  };
  useSocketEvent<[MemberEventPayload]>(MEMBER_EVENTS[0], onMemberEvent);
  useSocketEvent<[MemberEventPayload]>(MEMBER_EVENTS[1], onMemberEvent);
  useSocketEvent<[MemberEventPayload]>(MEMBER_EVENTS[2], onMemberEvent);
  /** Void action: asks the server again after a failure. */
  const retry = () => void mutate();
  return { roster: data, error: error as unknown, retry };
};
