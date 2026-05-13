'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { PermissionsGrid, PermissionsGridRef } from '@/components/members/PermissionsGrid';
import { UserSearch } from '@/components/members/UserSearch';
import { ChevronLeft, UserPlus, User, RefreshCw, Shield, Mail } from 'lucide-react';
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
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [selectedUnifiedRole, setSelectedUnifiedRole] = useState<UnifiedRole>(null);
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
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
    setPendingEmail(null);
  };

  const handleInviteEmail = (email: string) => {
    setPendingEmail(email);
    setSelectedUser(null);
  };

  const handleClearUser = () => {
    setSelectedUser(null);
    setPendingEmail(null);
    setPermissions(new Map());
    setSelectedUnifiedRole(null);
    setExpiryDays(null);
  };

  const handlePermissionChange = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
    setPermissions(prevPermissions => {
      const newPermissions = new Map(prevPermissions);
      newPermissions.set(pageId, perms);
      return newPermissions;
    });
  };

  const handleInvite = async () => {
    if (!selectedUser && !pendingEmail) return;

    const backendRole = selectedUnifiedRole?.type === 'admin' ? 'ADMIN' : 'MEMBER';
    const backendCustomRoleId = selectedUnifiedRole?.type === 'custom'
      ? selectedUnifiedRole.roleId
      : null;
    const isAdmin = selectedUnifiedRole?.type === 'admin';

    // Snapshot the email at submit time so the toast renders the right address
    // even if pendingEmail changes before the async response resolves.
    const submittedEmail = pendingEmail;

    let payload: Record<string, unknown>;
    if (pendingEmail) {
      // Email-payload path: page permissions cannot be granted to a user who
      // has not joined yet, so we always send an empty permissions array.
      payload = {
        email: pendingEmail,
        role: backendRole,
        customRoleId: backendCustomRoleId,
        permissions: [],
        ...(expiryDays !== null && { expiryDays }),
      };
    } else if (isAdmin) {
      payload = {
        userId: selectedUser!.userId,
        role: 'ADMIN',
        customRoleId: null,
        permissions: [],
      };
    } else {
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

      payload = {
        userId: selectedUser!.userId,
        role: backendRole,
        customRoleId: backendCustomRoleId,
        permissions: permissionArray,
      };
    }

    setSaving(true);
    try {
      const response = await post<{ kind?: 'invited' | 'added'; email?: string }>(
        `/api/drives/${driveId}/members/invite`,
        payload
      );

      if (response?.kind === 'invited' && submittedEmail) {
        toast({
          title: 'Invitation sent',
          description: `Invitation sent to ${submittedEmail}`,
        });
      } else {
        toast({
          title: 'Success',
          description: isAdmin ? 'Admin invited successfully' : 'Member invited successfully',
        });
      }

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
                : pendingEmail
                  ? 'No matching user — they will receive an email invitation.'
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
            ) : pendingEmail ? (
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <div className="flex items-center space-x-4">
                  <Avatar className="w-12 h-12">
                    <AvatarFallback>
                      <Mail className="w-5 h-5" />
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">{pendingEmail}</p>
                    <p className="text-sm text-muted-foreground">Will receive an email invitation</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={handleClearUser}>
                  Change
                </Button>
              </div>
            ) : (
              <UserSearch onSelect={handleUserSelect} onInviteEmail={handleInviteEmail} />
            )}
          </CardContent>
        </Card>

        {/* Role & Permissions - Show when user is selected OR an email invitation is pending */}
        {(selectedUser || pendingEmail) && (
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

            {/* Invite expiry — only relevant for email invites that create a pending row */}
            {pendingEmail && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Invite expiry</CardTitle>
                  <CardDescription>
                    Set when this invite link expires. Leave as &ldquo;Never&rdquo; for a permanent invite.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="max-w-xs">
                    <Select
                      value={expiryDays === null ? 'never' : String(expiryDays)}
                      onValueChange={(v) => setExpiryDays(v === 'never' ? null : Number(v))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">Never</SelectItem>
                        <SelectItem value="1">1 day</SelectItem>
                        <SelectItem value="7">7 days</SelectItem>
                        <SelectItem value="30">30 days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Permissions Card - Hidden when Admin is selected or for pending email invites */}
            {selectedUnifiedRole?.type !== 'admin' && !pendingEmail && (
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
                    readOnlyDriveRoot
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
