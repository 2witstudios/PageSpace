'use client';

import useSWR from 'swr';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import type { MemberWithDetails } from '@pagespace/lib/services/drive-member-service';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error('Failed to fetch members');
  return response.json();
};

function memberName(m: MemberWithDetails): string {
  return m.profile?.displayName || m.user?.name || m.user?.email || 'Member';
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter((n) => n.length > 0)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

interface DriveMembersAvatarsProps {
  driveId: string;
  maxVisible?: number;
}

/**
 * Stacked avatars of the members of a drive — gives the workspace a sense of
 * being shared and populated. Read-only; mirrors the avatar-stack styling of
 * PageViewers but is fed by the drive members endpoint instead of presence.
 */
export function DriveMembersAvatars({ driveId, maxVisible = 5 }: DriveMembersAvatarsProps) {
  const { data, isLoading } = useSWR<{ members: MemberWithDetails[] }>(
    `/api/drives/${driveId}/members`,
    fetcher,
    { revalidateOnFocus: false }
  );

  if (isLoading) {
    return (
      <div className="flex items-center">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className={cn('size-6 rounded-full -ml-2 first:ml-0')} />
        ))}
      </div>
    );
  }

  const members = data?.members ?? [];
  if (members.length === 0) return null;

  const visible = members.slice(0, maxVisible);
  const overflow = members.length - maxVisible;

  return (
    <div className="flex items-center" role="group" aria-label="Workspace members">
      {visible.map((member) => {
        const name = memberName(member);
        return (
          <Tooltip key={member.userId}>
            <TooltipTrigger asChild>
              <Avatar className="relative size-6 -ml-2 first:ml-0 ring-2 ring-background cursor-default">
                {member.profile?.avatarUrl ? (
                  <AvatarImage src={member.profile.avatarUrl} alt={name} />
                ) : null}
                <AvatarFallback className="text-[10px] font-medium">
                  {getInitials(name)}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent side="bottom">{name}</TooltipContent>
          </Tooltip>
        );
      })}
      {overflow > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="relative flex items-center justify-center size-6 -ml-2 rounded-full bg-muted ring-2 ring-background text-[10px] font-medium text-muted-foreground cursor-default">
              +{overflow}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-0.5">
              {members.slice(maxVisible).map((m) => (
                <span key={m.userId}>{memberName(m)}</span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
