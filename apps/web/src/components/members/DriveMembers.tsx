'use client';

import { useCallback, useEffect, useState } from 'react';
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
  acceptedAt?: string | null;
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

export function DriveMembers({ driveId }: DriveMembersProps) {
  const [members, setMembers] = useState<DriveMember[]>([]);
  const [currentUserRole, setCurrentUserRole] = useState<'OWNER' | 'ADMIN' | 'MEMBER'>('MEMBER');
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const { toast } = useToast();
  const socket = useSocket();

  const fetchMembers = useCallback(async () => {
    try {
      const response = await fetchWithAuth(`/api/drives/${driveId}/members`);
      if (!response.ok) throw new Error('Failed to fetch members');
      const data = await response.json();
      setMembers(data.members);
      setCurrentUserRole(data.currentUserRole || 'MEMBER');
    } catch (error) {
      console.error('Error fetching members:', error);
      toast({
        title: 'Error',
        description: 'Failed to load drive members',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [driveId, toast]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    if (!socket) return;
    const handler = (payload: { driveId?: string }) => {
      if (payload?.driveId === driveId) fetchMembers();
    };
    socket.on('drive:member_added', handler);
    socket.on('drive:member_removed', handler);
    return () => {
      socket.off('drive:member_added', handler);
      socket.off('drive:member_removed', handler);
    };
  }, [socket, driveId, fetchMembers]);

  const handleResendInvitation = async (userIdToResend: string) => {
    try {
      await post(`/api/drives/${driveId}/members/${userIdToResend}/resend`, {});
      toast({
        title: 'Invitation resent',
        description: 'A new invitation email has been sent.',
      });
      fetchMembers();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resend invitation';
      toast({
        title: 'Error',
        description: message,
        variant: 'destructive',
      });
    }
  };

  const handleRemoveMember = async (userIdToRemove: string, isPending: boolean) => {
    const confirmMessage = isPending
      ? 'Revoke this pending invitation?'
      : 'Are you sure you want to remove this member?';
    if (!confirm(confirmMessage)) return;

    try {
      await del(`/api/drives/${driveId}/members/${userIdToRemove}`);
      setMembers((prev) => prev.filter((m) => m.userId !== userIdToRemove));
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

  // Strict null check so an explicit `acceptedAt: null` from the API is the
  // only thing that classifies a row as pending — undefined or a malformed
  // payload should not silently dump rows into the pending section.
  const acceptedMembers = members.filter((m) => m.acceptedAt != null);
  const pendingMembers = members.filter((m) => m.acceptedAt === null);

  return (
    <div className="space-y-6">
      {/* Header with Invite Button */}
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

      {/* Accepted Members List */}
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

      {/* Pending Invitations Section */}
      {pendingMembers.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
            Pending invitations ({pendingMembers.length})
          </h3>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
            {pendingMembers.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                driveId={driveId}
                currentUserRole={currentUserRole}
                isPending
                onRemove={() => handleRemoveMember(member.userId, true)}
                onResend={() => handleResendInvitation(member.userId)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}