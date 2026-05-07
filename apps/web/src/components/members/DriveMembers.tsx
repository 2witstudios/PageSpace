'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { UserPlus } from 'lucide-react';
import { MemberRow } from './MemberRow';
import { PendingInvitesSection } from './PendingInvitesSection';
import type { PendingInvite } from './PendingInviteRow';
import { useToast } from '@/hooks/useToast';
import { useSocket } from '@/hooks/useSocket';
import { del, fetchWithAuth } from '@/lib/auth/auth-fetch';

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
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
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
      setPendingInvites(data.pendingInvites ?? []);
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

  const handleRemoveMember = async (userId: string) => {
    if (!confirm('Are you sure you want to remove this member?')) return;

    try {
      await del(`/api/drives/${driveId}/members/${userId}`);

      setMembers((prev) => prev.filter((m) => m.userId !== userId));

      toast({
        title: 'Success',
        description: 'Member removed successfully',
      });
    } catch (error) {
      console.error('Error removing member:', error);
      toast({
        title: 'Error',
        description: 'Failed to remove member',
        variant: 'destructive',
      });
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    try {
      await del(`/api/drives/${driveId}/pending-invites/${inviteId}`);
      setPendingInvites((prev) => prev.filter((inv) => inv.id !== inviteId));
      toast({
        title: 'Invitation revoked',
        description: 'The invitation link no longer works.',
      });
    } catch (error) {
      console.error('Error revoking invite:', error);
      toast({
        title: 'Error',
        description: 'Failed to revoke invitation',
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

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Members ({members.length})</h2>
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
        {members.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            No members yet. Invite someone to collaborate!
          </div>
        ) : (
          members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              driveId={driveId}
              currentUserRole={currentUserRole}
              onRemove={() => handleRemoveMember(member.userId)}
            />
          ))
        )}
      </div>

      <PendingInvitesSection
        invites={pendingInvites}
        currentUserRole={currentUserRole}
        onRevoke={handleRevokeInvite}
      />
    </div>
  );
}
