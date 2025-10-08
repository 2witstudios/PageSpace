'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { UserPlus } from 'lucide-react';
import { InviteMemberModal } from './InviteMemberModal';
import { MemberRow } from './MemberRow';
import { useToast } from '@/hooks/use-toast';
import { del } from '@/lib/auth-fetch';

interface DriveMember {
  id: string;
  userId: string;
  role: string;
  invitedAt: string;
  acceptedAt?: string;
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
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const { toast } = useToast();

  const fetchMembers = async () => {
    try {
      const response = await fetch(`/api/drives/${driveId}/members`, {
        credentials: 'include',
      });
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
  };

  useEffect(() => {
    fetchMembers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveId]);

  const handleInviteComplete = () => {
    setInviteModalOpen(false);
    fetchMembers(); // Refresh the member list
    toast({
      title: 'Success',
      description: 'Member invited successfully',
    });
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!confirm('Are you sure you want to remove this member?')) return;

    try {
      await del(`/api/drives/${driveId}/members/${memberId}`);

      toast({
        title: 'Success',
        description: 'Member removed successfully',
      });

      fetchMembers();
    } catch (error) {
      console.error('Error removing member:', error);
      toast({
        title: 'Error',
        description: 'Failed to remove member',
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
      {/* Header with Invite Button */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Members ({members.length})</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            People with access to this drive
          </p>
        </div>
        {(currentUserRole === 'OWNER' || currentUserRole === 'ADMIN') && (
          <Button onClick={() => setInviteModalOpen(true)}>
            <UserPlus className="w-4 h-4 mr-2" />
            Invite Member
          </Button>
        )}
      </div>

      {/* Members List */}
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
              onRemove={() => handleRemoveMember(member.id)}
            />
          ))
        )}
      </div>

      {/* Invite Modal */}
      {inviteModalOpen && (
        <InviteMemberModal
          driveId={driveId}
          isOpen={inviteModalOpen}
          onClose={() => setInviteModalOpen(false)}
          onComplete={handleInviteComplete}
        />
      )}
    </div>
  );
}