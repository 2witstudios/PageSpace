'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { PermissionsGrid, PermissionsGridRef } from '@/components/members/PermissionsGrid';
import { UserSearch } from '@/components/members/UserSearch';
import { ChevronLeft, UserPlus, User, RefreshCw, Shield } from 'lucide-react';
import { useToast } from '@/hooks/useToast';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { post, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { getRoleColorClasses } from '@/lib/utils';
import { VerificationRequiredAlert } from '@/components/VerificationRequiredAlert';

interface SelectedUser {
  userId: string;
  username?: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
}

interface CustomRole {
  id: string;
  name: string;
  description?: string;
  color?: string;
  isDefault: boolean;
  permissions: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
}

// Unified role type: Admin or a custom role
type UnifiedRole = { type: 'admin' } | { type: 'custom'; roleId: string } | null;

export default function InviteMemberPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const driveId = params.driveId as string;

  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [selectedUnifiedRole, setSelectedUnifiedRole] = useState<UnifiedRole>(null);
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [saving, setSaving] = useState(false);
  const [showVerificationAlert, setShowVerificationAlert] = useState(false);
  const permissionsGridRef = useRef<PermissionsGridRef>(null);

  // Fetch custom roles
  useEffect(() => {
    const fetchRoles = async () => {
      try {
        const response = await fetchWithAuth(`/api/drives/${driveId}/roles`);
        if (response.ok) {
          const data = await response.json();
          setCustomRoles(data.roles || []);
          // Auto-select default role if exists
          const defaultRole = data.roles?.find((r: CustomRole) => r.isDefault);
          if (defaultRole) {
            setSelectedUnifiedRole({ type: 'custom', roleId: defaultRole.id });
            // PermissionsGrid will apply the role permissions via rolePermissions prop
          }
        }
      } catch (error) {
        console.error('Error fetching roles:', error);
      }
    };
    fetchRoles();
  }, [driveId]);

  // Unified role change handler
  const handleUnifiedRoleChange = (value: string) => {
    if (value === 'admin') {
      setSelectedUnifiedRole({ type: 'admin' });
      setPermissions(new Map()); // Clear permissions - admin has full access
    } else if (value === 'none') {
      setSelectedUnifiedRole(null);
    } else {
      setSelectedUnifiedRole({ type: 'custom', roleId: value });
      // Apply role permissions imperatively
      const role = customRoles.find(r => r.id === value);
      if (role && permissionsGridRef.current) {
        permissionsGridRef.current.applyRolePermissions(role.permissions);
      }
    }
  };

  const handleSyncToRole = () => {
    if (selectedUnifiedRole?.type === 'custom') {
      const role = customRoles.find(r => r.id === selectedUnifiedRole.roleId);
      if (role && permissionsGridRef.current) {
        permissionsGridRef.current.applyRolePermissions(role.permissions);
        toast({
          title: 'Permissions synced',
          description: `Permissions reset to "${role.name}" defaults`,
        });
      }
    }
  };

  const handleUserSelect = (user: SelectedUser) => {
    setSelectedUser(user);
  };

  const handleClearUser = () => {
    setSelectedUser(null);
    setPermissions(new Map());
    setSelectedUnifiedRole(null);
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

    // Map unified role back to backend model
    const backendRole = selectedUnifiedRole?.type === 'admin' ? 'ADMIN' : 'MEMBER';
    const backendCustomRoleId = selectedUnifiedRole?.type === 'custom'
      ? selectedUnifiedRole.roleId
      : null;

    // Skip permission validation for Admin
    if (selectedUnifiedRole?.type === 'admin') {
      setSaving(true);
      try {
        await post(`/api/drives/${driveId}/members/invite`, {
          userId: selectedUser.userId,
          role: 'ADMIN',
          customRoleId: null,
          permissions: [],
        });

        toast({
          title: 'Success',
          description: 'Admin invited successfully',
        });

        router.push(`/dashboard/${driveId}/members`);
      } catch (error) {
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
      return;
    }

    // For non-admin, convert permissions map to array format
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
        role: backendRole,
        customRoleId: backendCustomRoleId,
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
            {/* Unified Role Selection Card */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Role</CardTitle>
                <CardDescription>
                  Choose the role for this member
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-w-md">
                  <Label htmlFor="unified-role-select" className="sr-only">Role</Label>
                  <Select
                    value={
                      selectedUnifiedRole?.type === 'admin'
                        ? 'admin'
                        : selectedUnifiedRole?.type === 'custom'
                          ? selectedUnifiedRole.roleId
                          : 'none'
                    }
                    onValueChange={handleUnifiedRoleChange}
                  >
                    <SelectTrigger id="unified-role-select">
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      {/* Admin - always first */}
                      <SelectItem value="admin">
                        <div className="flex items-center gap-2">
                          <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                            Admin
                          </Badge>
                          <span className="text-xs text-muted-foreground">Full access</span>
                        </div>
                      </SelectItem>

                      {customRoles.length > 0 && <SelectSeparator />}

                      {/* Custom roles */}
                      {customRoles.map((role) => (
                        <SelectItem key={role.id} value={role.id}>
                          <div className="flex items-center gap-2">
                            <Badge className={getRoleColorClasses(role.color)}>
                              {role.name}
                            </Badge>
                            {role.isDefault && (
                              <span className="text-xs text-muted-foreground">Default</span>
                            )}
                          </div>
                        </SelectItem>
                      ))}

                      {customRoles.length === 0 && <SelectSeparator />}

                      {/* No role option */}
                      <SelectItem value="none">
                        <span className="text-muted-foreground">No role</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground mt-2">
                    {selectedUnifiedRole?.type === 'admin'
                      ? 'Admins have the same permissions as drive owners and can manage members.'
                      : 'This role defines which pages this member can access.'}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Permissions Card - Hidden when Admin is selected */}
            {selectedUnifiedRole?.type !== 'admin' && (
              <Card className="mb-6">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Page Permissions</CardTitle>
                      <CardDescription>
                        Select which pages this member can access
                      </CardDescription>
                    </div>
                    {selectedUnifiedRole?.type === 'custom' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSyncToRole}
                        title="Reset permissions to role defaults"
                      >
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Sync to role
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <PermissionsGrid
                    ref={permissionsGridRef}
                    driveId={driveId}
                    permissions={permissions}
                    onChange={handlePermissionChange}
                  />
                </CardContent>
              </Card>
            )}

            {/* Admin Access Card - When Admin role is selected */}
            {selectedUnifiedRole?.type === 'admin' && (
              <Card className="mb-6">
                <CardContent className="py-8">
                  <div className="text-center">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900/30 mb-4">
                      <Shield className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                    </div>
                    <h3 className="text-lg font-semibold mb-2">Admin Access</h3>
                    <p className="text-muted-foreground">
                      Admins have full access to all pages, just like the drive owner.
                    </p>
                    <p className="text-sm text-muted-foreground mt-2">
                      No permission configuration needed.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

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
