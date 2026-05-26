'use client';

import { useEffect, useState } from 'react';
import { usePageStore } from '@/hooks/usePage';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Trash2, Shield, Users } from 'lucide-react';
import { toast } from 'sonner';
import { post, del, put, fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { RoleGrant } from '@/services/api';

type User = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

type Permission = {
  id: string;
  userId: string;
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  grantedBy: string | null;
  grantedAt: Date;
  user: User | null;
};

type PermissionsData = {
  owner: User;
  permissions: Permission[];
  roles: RoleGrant[];
};

export function PermissionsList() {
  const pageId = usePageStore((state) => state.pageId);
  const [data, setData] = useState<PermissionsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [updatingPermissions, setUpdatingPermissions] = useState<Set<string>>(new Set());
  const [updatingRoles, setUpdatingRoles] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!pageId) return;

    const fetchPermissions = async () => {
      setIsLoading(true);
      try {
        const response = await fetchWithAuth(`/api/pages/${pageId}/permissions`);
        if (!response.ok) {
          throw new Error('Failed to fetch permissions');
        }
        const result: PermissionsData = await response.json();
        setData(result);
      } catch (error) {
        console.error(error);
        toast.error('Could not load permissions.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchPermissions();
  }, [pageId]);

  const handlePermissionUpdate = async (
    userId: string,
    field: 'canView' | 'canEdit' | 'canShare' | 'canDelete',
    value: boolean
  ) => {
    if (!data || !pageId) return;

    const currentPerm = data.permissions.find(p => p.userId === userId);
    if (!currentPerm) return;

    const updatedPerm = { ...currentPerm };

    if (field === 'canView' && !value) {
      updatedPerm.canView = false;
      updatedPerm.canEdit = false;
      updatedPerm.canShare = false;
      updatedPerm.canDelete = false;
    } else if ((field === 'canEdit' || field === 'canShare' || field === 'canDelete') && value) {
      updatedPerm.canView = true;
      updatedPerm[field] = value;
    } else {
      updatedPerm[field] = value;
    }

    setData({
      ...data,
      permissions: data.permissions.map(p =>
        p.userId === userId ? updatedPerm : p
      )
    });

    setUpdatingPermissions(prev => new Set(prev).add(userId));

    try {
      await post(`/api/pages/${pageId}/permissions`, {
        userId,
        canView: updatedPerm.canView,
        canEdit: updatedPerm.canEdit,
        canShare: updatedPerm.canShare,
        canDelete: updatedPerm.canDelete,
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to update permission.');
      setData({
        ...data,
        permissions: data.permissions.map(p =>
          p.userId === userId ? currentPerm : p
        )
      });
    } finally {
      setUpdatingPermissions(prev => {
        const newSet = new Set(prev);
        newSet.delete(userId);
        return newSet;
      });
    }
  };

  const handleRemovePermission = async (userId: string) => {
    if (!data || !pageId) return;

    const originalData = data;

    setData({
      ...data,
      permissions: data.permissions.filter(p => p.userId !== userId)
    });

    try {
      await del(`/api/pages/${pageId}/permissions`, { userId });
      toast.success('Permission removed.');
    } catch (error) {
      console.error(error);
      toast.error('Failed to remove permission.');
      setData(originalData);
    }
  };

  const handleRolePermissionUpdate = async (
    roleId: string,
    field: 'canView' | 'canEdit' | 'canShare',
    value: boolean
  ) => {
    if (!data || !pageId) return;

    const currentRole = data.roles.find(r => r.roleId === roleId);
    if (!currentRole) return;

    const updatedRole = { ...currentRole };

    if (field === 'canView' && !value) {
      updatedRole.canView = false;
      updatedRole.canEdit = false;
      updatedRole.canShare = false;
    } else if ((field === 'canEdit' || field === 'canShare') && value) {
      updatedRole.canView = true;
      updatedRole[field] = value;
    } else {
      updatedRole[field] = value;
    }

    setData({
      ...data,
      roles: data.roles.map(r => r.roleId === roleId ? updatedRole : r),
    });

    setUpdatingRoles(prev => new Set(prev).add(roleId));

    try {
      await put(`/api/pages/${pageId}/role-permissions`, {
        roleId,
        canView: updatedRole.canView,
        canEdit: updatedRole.canEdit,
        canShare: updatedRole.canShare,
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to update role permission.');
      setData({
        ...data,
        roles: data.roles.map(r => r.roleId === roleId ? currentRole : r),
      });
    } finally {
      setUpdatingRoles(prev => {
        const newSet = new Set(prev);
        newSet.delete(roleId);
        return newSet;
      });
    }
  };

  const handleRemoveRolePermission = async (roleId: string) => {
    if (!data || !pageId) return;

    const originalData = data;

    setData({
      ...data,
      roles: data.roles.filter(r => r.roleId !== roleId),
    });

    try {
      await del(`/api/pages/${pageId}/role-permissions`, { roleId });
      toast.success('Role access removed.');
    } catch (error) {
      console.error(error);
      toast.error('Failed to remove role access.');
      setData(originalData);
    }
  };

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const { owner, permissions, roles } = data;

  return (
    <div className="space-y-4">
      {/* Owner */}
      <div className="flex items-center justify-between p-3 border rounded-lg bg-purple-50 dark:bg-purple-900/20">
        <div className="flex items-center space-x-3">
          <Avatar className="h-8 w-8">
            <AvatarImage src={owner.image || undefined} />
            <AvatarFallback>
              {owner.name?.[0]?.toUpperCase() || owner.email?.[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="text-sm font-medium">{owner.name || owner.email}</p>
            <p className="text-xs text-muted-foreground">Owner</p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Shield className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          <span className="text-xs font-medium text-purple-600 dark:text-purple-400">Full Access</span>
        </div>
      </div>

      {/* Role Access */}
      {roles.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Roles</p>
          {roles.map((role) => (
            <div
              key={role.roleId}
              className="flex items-center justify-between p-3 border rounded-lg"
            >
              <div className="flex items-center space-x-3">
                <div
                  className="h-8 w-8 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: role.color ?? undefined }}
                >
                  <Users className="h-4 w-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-medium">{role.name}</p>
                  <p className="text-xs text-muted-foreground">Role</p>
                </div>
              </div>

              <div className="flex items-center space-x-4">
                <div className="flex items-center space-x-3">
                  <label className="flex items-center space-x-1">
                    <Checkbox
                      checked={role.canView}
                      disabled={updatingRoles.has(role.roleId)}
                      onCheckedChange={(checked) =>
                        handleRolePermissionUpdate(role.roleId, 'canView', !!checked)
                      }
                    />
                    <span className="text-xs">View</span>
                  </label>

                  <label className="flex items-center space-x-1">
                    <Checkbox
                      checked={role.canEdit}
                      disabled={!role.canView || updatingRoles.has(role.roleId)}
                      onCheckedChange={(checked) =>
                        handleRolePermissionUpdate(role.roleId, 'canEdit', !!checked)
                      }
                    />
                    <span className="text-xs">Edit</span>
                  </label>

                  <label className="flex items-center space-x-1">
                    <Checkbox
                      checked={role.canShare}
                      disabled={!role.canView || updatingRoles.has(role.roleId)}
                      onCheckedChange={(checked) =>
                        handleRolePermissionUpdate(role.roleId, 'canShare', !!checked)
                      }
                    />
                    <span className="text-xs">Share</span>
                  </label>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveRolePermission(role.roleId)}
                  className="text-red-600 hover:text-red-700"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Shared Users */}
      {permissions.length === 0 && roles.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">
          This page hasn&apos;t been shared with anyone yet.
        </p>
      ) : permissions.length > 0 ? (
        <div className="space-y-2">
          {roles.length > 0 && (
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">People</p>
          )}
          {permissions.map((permission) => (
            <div
              key={permission.id}
              className="flex items-center justify-between p-3 border rounded-lg"
            >
              <div className="flex items-center space-x-3">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={permission.user?.image || undefined} />
                  <AvatarFallback>
                    {permission.user?.name?.[0]?.toUpperCase() ||
                     permission.user?.email?.[0]?.toUpperCase() || '?'}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-medium">
                    {permission.user?.name || permission.user?.email || 'Unknown User'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {permission.user?.email}
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-4">
                <div className="flex items-center space-x-3">
                  <label className="flex items-center space-x-1">
                    <Checkbox
                      checked={permission.canView}
                      disabled={updatingPermissions.has(permission.userId)}
                      onCheckedChange={(checked) =>
                        handlePermissionUpdate(permission.userId, 'canView', !!checked)
                      }
                    />
                    <span className="text-xs">View</span>
                  </label>

                  <label className="flex items-center space-x-1">
                    <Checkbox
                      checked={permission.canEdit}
                      disabled={!permission.canView || updatingPermissions.has(permission.userId)}
                      onCheckedChange={(checked) =>
                        handlePermissionUpdate(permission.userId, 'canEdit', !!checked)
                      }
                    />
                    <span className="text-xs">Edit</span>
                  </label>

                  <label className="flex items-center space-x-1">
                    <Checkbox
                      checked={permission.canShare}
                      disabled={!permission.canView || updatingPermissions.has(permission.userId)}
                      onCheckedChange={(checked) =>
                        handlePermissionUpdate(permission.userId, 'canShare', !!checked)
                      }
                    />
                    <span className="text-xs">Share</span>
                  </label>

                  <label className="flex items-center space-x-1">
                    <Checkbox
                      checked={permission.canDelete}
                      disabled={!permission.canView || updatingPermissions.has(permission.userId)}
                      onCheckedChange={(checked) =>
                        handlePermissionUpdate(permission.userId, 'canDelete', !!checked)
                      }
                    />
                    <span className="text-xs">Delete</span>
                  </label>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemovePermission(permission.userId)}
                  className="text-red-600 hover:text-red-700"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
