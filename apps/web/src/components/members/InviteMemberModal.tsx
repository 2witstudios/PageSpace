'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { UserSearch } from './UserSearch';
import { PermissionsGrid } from './PermissionsGrid';
import { useToast } from '@/hooks/use-toast';
import { ChevronLeft } from 'lucide-react';

interface InviteMemberModalProps {
  driveId: string;
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
}

interface SelectedUser {
  userId: string;
  username?: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
}

export function InviteMemberModal({ driveId, isOpen, onClose, onComplete }: InviteMemberModalProps) {
  const [step, setStep] = useState<'search' | 'permissions'>('search');
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleUserSelect = (user: SelectedUser) => {
    setSelectedUser(user);
    setStep('permissions');
  };

  const handleBack = () => {
    setStep('search');
  };

  const handlePermissionsChange = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
    const newPermissions = new Map(permissions);
    newPermissions.set(pageId, perms);
    setPermissions(newPermissions);
  };

  const handleInvite = async () => {
    if (!selectedUser) return;

    // Convert permissions map to array format
    const permissionArray = Array.from(permissions.entries())
      .filter(([, perms]) => perms.canView || perms.canEdit || perms.canShare)
      .map(([pageId, perms]) => ({
        pageId,
        canView: perms.canView,
        canEdit: perms.canEdit,
        canShare: perms.canShare,
      }));

    if (permissionArray.length === 0) {
      toast({
        title: 'No permissions selected',
        description: 'Please select at least one permission to grant',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`/api/drives/${driveId}/members/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          userId: selectedUser.userId,
          permissions: permissionArray,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to invite member');
      }

      onComplete();
    } catch (error) {
      console.error('Error inviting member:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to invite member',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {step === 'search' ? 'Invite Member' : 'Set Permissions'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          {step === 'search' ? (
            <UserSearch onSelect={handleUserSelect} />
          ) : (
            <div className="h-full flex flex-col">
              {/* Selected User Info */}
              <div className="mb-4 p-3 bg-gray-50 rounded-lg flex items-center justify-between">
                <div>
                  <p className="font-medium">{selectedUser?.displayName}</p>
                  <p className="text-sm text-gray-600">{selectedUser?.email}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleBack}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Change User
                </Button>
              </div>

              {/* Permissions Grid */}
              <div className="flex-1 overflow-auto">
                <PermissionsGrid
                  driveId={driveId}
                  userId={selectedUser?.userId}
                  permissions={permissions}
                  onChange={handlePermissionsChange}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        {step === 'permissions' && (
          <div className="border-t pt-4 flex justify-between">
            <Button variant="outline" onClick={handleBack}>
              Back
            </Button>
            <div className="space-x-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleInvite} disabled={loading}>
                {loading ? 'Inviting...' : 'Send Invite'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}