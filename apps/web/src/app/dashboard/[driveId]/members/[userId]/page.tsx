'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { PermissionsGrid, PermissionsGridRef } from '@/components/members/PermissionsGrid';
import { ChevronLeft, Save, X, Shield, RefreshCw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { getRoleColorClasses } from '@/lib/utils';

interface MemberDetails {
  id: string;
  userId: string;
  role: string;
  customRoleId?: string | null;
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
  drive: {
    id: string;
    name: string;
    slug: string;
    ownerId: string;
  };
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

export default function MemberSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const driveId = params.driveId as string;
  const userId = params.userId as string;

  const [member, setMember] = useState<MemberDetails | null>(null);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [selectedUnifiedRole, setSelectedUnifiedRole] = useState<UnifiedRole>(null);
  const [originalUnifiedRole, setOriginalUnifiedRole] = useState<UnifiedRole>(null);
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [originalPermissions, setOriginalPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const permissionsGridRef = useRef<PermissionsGridRef>(null);

  useEffect(() => {
    fetchMemberDetails();
    fetchRoles();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveId, userId]);

  const fetchRoles = async () => {
    try {
      const response = await fetchWithAuth(`/api/drives/${driveId}/roles`);
      if (response.ok) {
        const data = await response.json();
        setCustomRoles(data.roles || []);
      }
    } catch (error) {
      console.error('Error fetching roles:', error);
    }
  };

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

  // Helper to compare unified roles
  const unifiedRolesEqual = (a: UnifiedRole, b: UnifiedRole): boolean => {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    if (a.type !== b.type) return false;
    if (a.type === 'admin') return true;
    if (a.type === 'custom' && b.type === 'custom') return a.roleId === b.roleId;
    return false;
  };

  useEffect(() => {
    // Check if permissions or role have changed
    const roleChanged = !unifiedRolesEqual(selectedUnifiedRole, originalUnifiedRole);
    const permsChanged = originalPermissions.size > 0 && Array.from(permissions.entries()).some(([pageId, perms]) => {
      const original = originalPermissions.get(pageId);
      if (!original) return true;
      return original.canView !== perms.canView ||
             original.canEdit !== perms.canEdit ||
             original.canShare !== perms.canShare;
    });
    setHasChanges(roleChanged || permsChanged);
  }, [permissions, originalPermissions, selectedUnifiedRole, originalUnifiedRole]);

  const fetchMemberDetails = async () => {
    try {
      const response = await fetchWithAuth(`/api/drives/${driveId}/members/${userId}`);
      if (!response.ok) {
        if (response.status === 403) {
          toast({
            title: 'Access Denied',
            description: 'Only drive owners and admins can manage member settings',
            variant: 'destructive',
          });
          router.push(`/dashboard/${driveId}/members`);
          return;
        }
        throw new Error('Failed to fetch member details');
      }
      const data = await response.json();
      setMember(data.member);

      // Initialize unified role state from backend model
      let unifiedRole: UnifiedRole = null;
      if (data.member.role === 'ADMIN') {
        unifiedRole = { type: 'admin' };
      } else if (data.member.customRoleId) {
        unifiedRole = { type: 'custom', roleId: data.member.customRoleId };
      }
      setSelectedUnifiedRole(unifiedRole);
      setOriginalUnifiedRole(unifiedRole);

      // Initialize permissions map
      if (data.permissions) {
        const permsMap = new Map();
        data.permissions.forEach((perm: { pageId: string; canView: boolean; canEdit: boolean; canShare: boolean }) => {
          permsMap.set(perm.pageId, {
            canView: perm.canView,
            canEdit: perm.canEdit,
            canShare: perm.canShare,
          });
        });
        setPermissions(permsMap);
        setOriginalPermissions(new Map(permsMap));
      }
    } catch (error) {
      console.error('Error fetching member details:', error);
      toast({
        title: 'Error',
        description: 'Failed to load member details',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePermissionChange = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
    setPermissions(prevPermissions => {
      const newPermissions = new Map(prevPermissions);
      newPermissions.set(pageId, perms);
      return newPermissions;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Map unified role back to backend model
      const backendRole = selectedUnifiedRole?.type === 'admin' ? 'ADMIN' : 'MEMBER';
      const backendCustomRoleId = selectedUnifiedRole?.type === 'custom'
        ? selectedUnifiedRole.roleId
        : null;

      const permissionsArray = Array.from(permissions.entries()).map(([pageId, perms]) => ({
        pageId,
        ...perms
      }));

      await patch(`/api/drives/${driveId}/members/${userId}`, {
        role: backendRole,
        customRoleId: backendCustomRoleId,
        permissions: permissionsArray
      });

      toast({
        title: 'Success',
        description: 'Member settings updated successfully',
      });

      setOriginalPermissions(new Map(permissions));
      setOriginalUnifiedRole(selectedUnifiedRole);
      setHasChanges(false);
    } catch (error) {
      console.error('Error saving changes:', error);
      toast({
        title: 'Error',
        description: 'Failed to save changes',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setPermissions(new Map(originalPermissions));
    setSelectedUnifiedRole(originalUnifiedRole);
    setHasChanges(false);
  };

  if (loading) {
    return (
      <div className="h-full overflow-auto">
        <div className="max-w-6xl mx-auto p-6">
          <Skeleton className="h-8 w-48 mb-6" />
          <Skeleton className="h-32 w-full mb-6" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (!member) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500 dark:text-gray-400">Member not found</p>
      </div>
    );
  }

  const displayName = member.profile?.displayName || member.user.name || 'Unknown User';
  const initials = displayName
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'OWNER':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
      case 'ADMIN':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
    }
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
          
          <h1 className="text-2xl font-bold">Member Settings</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            Manage permissions for {displayName} in {member.drive.name}
          </p>
        </div>

        {/* Member Info Card */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Member Information</CardTitle>
            <CardDescription>Details about this member</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-start space-x-4 mb-6">
              <Avatar className="w-16 h-16">
                <AvatarImage src={member.profile?.avatarUrl} alt={displayName} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>

              <div className="flex-1">
                <div className="flex items-center space-x-2 mb-2">
                  <h3 className="text-lg font-semibold">{displayName}</h3>
                  {member.profile?.username && (
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      @{member.profile.username}
                    </span>
                  )}
                  <Badge className={getRoleBadgeColor(member.role)}>
                    {member.role}
                  </Badge>
                </div>

                <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                  {member.user.email}
                </p>

                <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400">
                  <span>Invited: {new Date(member.invitedAt).toLocaleDateString()}</span>
                  {member.acceptedAt && (
                    <span>Joined: {new Date(member.acceptedAt).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Unified Role Selector - Only for non-owners */}
            {member.role !== 'OWNER' && (
              <div>
                <Label htmlFor="unified-role-select" className="mb-2 block">Role</Label>
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
                  <SelectTrigger id="unified-role-select" className="max-w-md">
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
                <p className="text-xs text-gray-500 dark:text-gray-500 mt-2">
                  {selectedUnifiedRole?.type === 'admin'
                    ? 'Admins have the same permissions as drive owners and can manage members.'
                    : 'This role defines which pages this member can access.'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Permissions Card - Hidden when Admin is selected */}
        {member.userId !== member.drive.ownerId && selectedUnifiedRole?.type !== 'admin' && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Page Permissions</CardTitle>
                  <CardDescription>
                    Control which pages this member can view, edit, or share
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
                userId={userId}
                permissions={permissions}
                onChange={handlePermissionChange}
              />
            </CardContent>
          </Card>
        )}

        {/* Owner Access Card */}
        {member.userId === member.drive.ownerId && (
          <Card>
            <CardContent className="py-8">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-purple-100 dark:bg-purple-900/30 mb-4">
                  <Shield className="w-8 h-8 text-purple-600 dark:text-purple-400" />
                </div>
                <h3 className="text-lg font-semibold mb-2">Owner Access</h3>
                <p className="text-gray-600 dark:text-gray-400">
                  Drive owners have full access to all pages by default.
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-500 mt-2">
                  No permission configuration needed.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Admin Access Card - When Admin role is selected */}
        {member.userId !== member.drive.ownerId && selectedUnifiedRole?.type === 'admin' && (
          <Card>
            <CardContent className="py-8">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900/30 mb-4">
                  <Shield className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                </div>
                <h3 className="text-lg font-semibold mb-2">Admin Access</h3>
                <p className="text-gray-600 dark:text-gray-400">
                  Admins have full access to all pages, just like the drive owner.
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-500 mt-2">
                  No permission configuration needed.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Action Buttons - Show when there are changes */}
        {member.userId !== member.drive.ownerId && (
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={!hasChanges || saving}
            >
              <X className="w-4 h-4 mr-2" />
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!hasChanges || saving}
            >
              <Save className="w-4 h-4 mr-2" />
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}