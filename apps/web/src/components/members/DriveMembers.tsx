'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { UserPlus } from 'lucide-react';
import { MemberRow } from './MemberRow';
import { useToast } from '@/hooks/useToast';
import { useSocket } from '@/hooks/useSocket';
import { del, fetchWithAuth, post } from '@/lib/auth/auth-fetch';

interface DriveMember {
  id: string;
  userId: string;
  role: string;
  invitedAt: string;
  acceptedAt: string | null;
  user: {
    id: string;
    email: string;
    name?: string;
  };
  profile?: {
    username?: string;
    displayName?: string;
    avatarUrl?: string;
  };
  customRole?: {
    id: string;
    name: string;
    color?: string | null;
  } | null;
  permissionCounts: {
    view: number;
    edit: number;
    share: number;
  };
}

interface DriveMembersProps {
  driveId: string;
}

interface DriveMemberSocketEvent {
  driveId: string;
  userId?: string;
  operation?: string;
}

const DRIVE_MEMBER_EVENTS = [
  'drive:member_added',
  'drive:member_removed',
  'drive:member_role_changed',
] as const;

export function DriveMembers({ driveId }: DriveMembersProps) {
  const [members, setMembers] = useState<DriveMember[]>([]);
  const [currentUserRole, setCurrentUserRole] = useState<'OWNER' | 'ADMIN' | 'MEMBER'>('MEMBER');
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const { toast } = useToast();
  const socket = useSocket();
  // Sequence guard: socket events can fire fetchMembers while a prior fetch is
  // in flight. Only the latest request commits state to avoid a stale response
  // overwriting a newer one.
  const requestSeqRef = useRef(0);

  const fetchMembers = useCallback(async () => {
    const currentSeq = ++requestSeqRef.current;
    try {
      const response = await fetchWithAuth(`/api/drives/${driveId}/members`);
      if (!response.ok) throw new Error('Failed to fetch members');
      const data = await response.json();
      if (currentSeq !== requestSeqRef.current) return;
      setMembers(data.members);
      setCurrentUserRole(data.currentUserRole || 'MEMBER');
    } catch (error) {
      if (currentSeq !== requestSeqRef.current) return;
      console.error('Error fetching members:', error);
      toast({
        title: 'Error',
        description: 'Failed to load drive members',
        variant: 'destructive',
      });
    } finally {
      if (currentSeq === requestSeqRef.current) setLoading(false);
    }
  }, [driveId, toast]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    if (!socket) return;

    const handler = (event: DriveMemberSocketEvent) => {
      if (event?.driveId !== driveId) return;
      fetchMembers();
    };

    DRIVE_MEMBER_EVENTS.forEach((eventName) => {
      socket.on(eventName, handler);
    });

    return () => {
      DRIVE_MEMBER_EVENTS.forEach((eventName) => {
        socket.off(eventName, handler);
      });
    };
  }, [socket, driveId, fetchMembers]);

  const handleResendInvitation = async (userId: string) => {
    try {
      await post(`/api/drives/${driveId}/members/${userId}/resend`);
      toast({
        title: 'Success',
        description: 'Invitation resent. A new invitation email has been sent.',
      });
      // Refetch so invitedAt-derived UI ("last sent N minutes ago") updates.
      fetchMembers();
    } catch (error) {
      const description =
        error instanceof Error ? error.message : 'Failed to resend invitation';
      toast({
        title: 'Error',
        description,
        variant: 'destructive',
      });
    }
  };

  const handleRemoveMember = async (userId: string, isPending: boolean) => {
    const message = isPending
      ? 'Are you sure you want to revoke this invitation?'
      : 'Are you sure you want to remove this member?';
    if (!confirm(message)) return;

    try {
      await del(`/api/drives/${driveId}/members/${userId}`);

      setMembers((prev) => prev.filter((m) => m.userId !== userId));

      toast({
        title: 'Success',
        description: isPending ? 'Invitation revoked' : 'Member removed successfully',
      });
    } catch (error) {
      console.error('Error removing member:', error);
      toast({
        title: 'Error',
        description: isPending ? 'Failed to revoke invitation' : 'Failed to remove member',
        variant: 'destructive',
      });
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900" />
      </div>
    );
  }

  // Strict null check: undefined from a malformed payload must not classify as pending.
  const acceptedMembers = members.filter((m) => m.acceptedAt != null);
  const pendingMembers = members.filter((m) => m.acceptedAt === null);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Members ({acceptedMembers.length})</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            People with access to this drive
          </p>
        </div>
        {(currentUserRole === 'OWNER' || currentUserRole === 'ADMIN') && (
          <Button onClick={() => router.push(`/dashboard/${driveId}/members/invite`)}>
            <UserPlus className="w-4 h-4 mr-2" />
            Invite Member
          </Button>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
        {acceptedMembers.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            No members yet. Invite someone to collaborate!
          </div>
        ) : (
          acceptedMembers.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              driveId={driveId}
              currentUserRole={currentUserRole}
              onRemove={() => handleRemoveMember(member.userId, false)}
            />
          ))
        )}
      </div>

      {pendingMembers.length > 0 && (
        <div>
          <div className="mb-3">
            <h2 className="text-lg font-semibold">Pending invitations ({pendingMembers.length})</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              People invited but not yet joined
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
            {pendingMembers.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                driveId={driveId}
                currentUserRole={currentUserRole}
                onRemove={() => handleRemoveMember(member.userId, true)}
                onResend={() => handleResendInvitation(member.userId)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
