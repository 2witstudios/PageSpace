'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PermissionsGrid } from '@/components/members/PermissionsGrid';
import { UserSearch } from '@/components/members/UserSearch';
import { ChevronLeft, UserPlus, User } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { post } from '@/lib/auth-fetch';
import { VerificationRequiredAlert } from '@/components/VerificationRequiredAlert';

interface SelectedUser {
  userId: string;
  username?: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
}

export default function InviteMemberPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const driveId = params.driveId as string;

  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [selectedRole, setSelectedRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [saving, setSaving] = useState(false);
  const [showVerificationAlert, setShowVerificationAlert] = useState(false);

  const handleUserSelect = (user: SelectedUser) => {
    setSelectedUser(user);
  };

  const handleClearUser = () => {
    setSelectedUser(null);
    setPermissions(new Map());
    setSelectedRole('MEMBER');
  };

  const handlePermissionChange = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
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

    setSaving(true);
    try {
      await post(`/api/drives/${driveId}/members/invite`, {
        userId: selectedUser.userId,
        role: selectedRole,
        permissions: permissionArray,
      });

      toast({
        title: 'Success',
        description: 'Member invited successfully',
      });

      router.push(`/dashboard/${driveId}/members`);
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
      setSaving(false);
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6">
        {/* Header with back button */}
        <div className="mb-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/dashboard/${driveId}/members`)}
            className="mb-4"
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back to Members
          </Button>

          <h1 className="text-2xl font-bold">Invite Member</h1>
          <p className="text-muted-foreground mt-1">
            Add a new member to this drive and configure their permissions
          </p>
        </div>

        {showVerificationAlert && (
          <div className="mb-6">
            <VerificationRequiredAlert onDismiss={() => setShowVerificationAlert(false)} />
          </div>
        )}

        {/* User Selection Card */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Select User</CardTitle>
            <CardDescription>
              {selectedUser
                ? 'User selected. You can change your selection below.'
                : 'Search for a user to invite to this drive'
              }
            </CardDescription>
          </CardHeader>
          <CardContent>
            {selectedUser ? (
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <div className="flex items-center space-x-4">
                  <Avatar className="w-12 h-12">
                    <AvatarImage src={selectedUser.avatarUrl} alt={selectedUser.displayName} />
                    <AvatarFallback>
                      {selectedUser.displayName ? getInitials(selectedUser.displayName) : <User className="w-5 h-5" />}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="flex items-center space-x-2">
                      <p className="font-medium">{selectedUser.displayName}</p>
                      {selectedUser.username && (
                        <span className="text-sm text-muted-foreground">@{selectedUser.username}</span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">{selectedUser.email}</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={handleClearUser}>
                  Change User
                </Button>
              </div>
            ) : (
              <UserSearch onSelect={handleUserSelect} />
            )}
          </CardContent>
        </Card>

        {/* Role & Permissions - Only show when user is selected */}
        {selectedUser && (
          <>
            {/* Role Selection Card */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Member Role</CardTitle>
                <CardDescription>
                  Choose the role for this member
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-w-md">
                  <Label htmlFor="role-select" className="sr-only">Member Role</Label>
                  <Select value={selectedRole} onValueChange={(value) => setSelectedRole(value as 'MEMBER' | 'ADMIN')}>
                    <SelectTrigger id="role-select">
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MEMBER">Member - Requires page permissions</SelectItem>
                      <SelectItem value="ADMIN">Admin - Full access to all pages</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground mt-2">
                    {selectedRole === 'ADMIN'
                      ? 'Admins have the same permissions as drive owners and can manage members.'
                      : 'Members only have access to pages explicitly shared with them below.'}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Permissions Card */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Page Permissions</CardTitle>
                <CardDescription>
                  Select which pages this member can access
                </CardDescription>
              </CardHeader>
              <CardContent>
                <PermissionsGrid
                  driveId={driveId}
                  permissions={permissions}
                  onChange={handlePermissionChange}
                />
              </CardContent>
            </Card>

            {/* Action Buttons */}
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => router.push(`/dashboard/${driveId}/members`)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button onClick={handleInvite} disabled={saving}>
                <UserPlus className="w-4 h-4 mr-2" />
                {saving ? 'Inviting...' : 'Invite Member'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
