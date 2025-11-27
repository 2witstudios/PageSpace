'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { UserSearch } from './UserSearch';
import { PermissionsGrid } from './PermissionsGrid';
import { useToast } from '@/hooks/use-toast';
import { ChevronLeft } from 'lucide-react';
import { VerificationRequiredAlert } from '@/components/VerificationRequiredAlert';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { post } from '@/lib/auth-fetch';

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
  const [selectedRole, setSelectedRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [loading, setLoading] = useState(false);
  const [showVerificationAlert, setShowVerificationAlert] = useState(false);
  const { toast } = useToast();

  const handleUserSelect = (user: SelectedUser) => {
    setSelectedUser(user);
    setStep('permissions');
  };

  const handleBack = () => {
    setStep('search');
  };

  const handlePermissionsChange = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
    setPermissions(prevPermissions => {
      const newPermissions = new Map(prevPermissions);
      newPermissions.set(pageId, perms);
      return newPermissions;
    });
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
      await post(`/api/drives/${driveId}/members/invite`, {
        userId: selectedUser.userId,
        role: selectedRole,
        permissions: permissionArray,
      });

      onComplete();
    } catch (error) {
      // Check if this is a verification required error
      if (error instanceof Error && 'requiresEmailVerification' in error) {
        setShowVerificationAlert(true);
        return;
      }
      console.error('Error adding member:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add member',
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
            {step === 'search' ? 'Add Member' : 'Set Permissions'}
          </DialogTitle>
        </DialogHeader>

        {showVerificationAlert && (
          <div className="mb-4">
            <VerificationRequiredAlert onDismiss={() => setShowVerificationAlert(false)} />
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {step === 'search' ? (
            <UserSearch onSelect={handleUserSelect} />
          ) : (
            <div className="h-full flex flex-col">
              {/* Selected User Info */}
              <div className="mb-4 p-3 bg-muted rounded-lg flex items-center justify-between">
                <div>
                  <p className="font-medium">{selectedUser?.displayName}</p>
                  <p className="text-sm text-muted-foreground">{selectedUser?.email}</p>
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

              {/* Role Selector */}
              <div className="mb-4">
                <Label htmlFor="role-select" className="mb-2 block">Member Role</Label>
                <Select value={selectedRole} onValueChange={(value) => setSelectedRole(value as 'MEMBER' | 'ADMIN')}>
                  <SelectTrigger id="role-select">
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MEMBER">Member - Requires page permissions</SelectItem>
                    <SelectItem value="ADMIN">Admin - Full access to all pages</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  {selectedRole === 'ADMIN'
                    ? 'Admins have the same permissions as drive owners and can manage members.'
                    : 'Members only have access to pages explicitly shared with them below.'}
                </p>
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
                {loading ? 'Adding...' : 'Add Member'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}