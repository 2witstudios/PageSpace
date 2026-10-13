'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/retained/components/ui/button';
import { Badge } from '@/retained/components/ui/badge';
import { Plus, Trash2, GripVertical, Star, Shield, Users, Eye } from 'lucide-react';
import { cn } from '@/retained/lib/utils';
import { SettingsGroup, SettingsScreen } from '@/ui/settings/settings-screen/settings-screen';
import { toast } from 'sonner';
import { useSocket } from '@/retained/hooks/useSocket';
import type { DriveEventPayload } from '@/retained-adapters/ui-contracts';
import { fetchWithAuth, del } from '@/retained/lib/auth/auth-fetch';
import { getRoleColorClasses } from '@/retained/lib/utils';
import { RoleEditor } from './RoleEditor';

const ROLES_LEDE = 'Bundles of page permissions you can hand to people, agents and apps.';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/retained/components/ui/alert-dialog';

interface Role {
  id: string;
  name: string;
  description?: string;
  color?: string;
  isDefault: boolean;
  permissions: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
  driveWidePermissions?: { canView: boolean; canEdit: boolean; canShare: boolean } | null;
  position: number;
}

interface RolesManagerProps {
  driveId: string;
}

export function RolesManager({ driveId }: RolesManagerProps) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingRoleId, setDeletingRoleId] = useState<string | null>(null);
  const socket = useSocket();

  const fetchRoles = async () => {
    try {
      const response = await fetchWithAuth(`/api/drives/${driveId}/roles`);
      if (!response.ok) throw new Error('Failed to fetch roles');
      const data = await response.json();
      setRoles(data.roles || []);
    } catch (error) {
      console.error('Error fetching roles:', error);
      toast.error('Failed to load roles');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRoles();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveId]);

  const handleDriveUpdated = useCallback((event: DriveEventPayload) => {
    if (event.driveId === driveId) {
      fetchRoles();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveId]);

  useEffect(() => {
    if (!socket) return;
    socket.on('drive:updated', handleDriveUpdated);
    return () => {
      socket.off('drive:updated', handleDriveUpdated);
    };
  }, [socket, handleDriveUpdated]);

  const handleDeleteRole = async (roleId: string) => {
    try {
      await del(`/api/drives/${driveId}/roles/${roleId}`);
      toast.success('Role deleted successfully');
      if (editingRole?.id === roleId) setEditingRole(null);
      fetchRoles();
    } catch (error) {
      console.error('Error deleting role:', error);
      toast.error('Failed to delete role');
    } finally {
      setDeletingRoleId(null);
    }
  };

  const handleRoleSaved = () => {
    setEditingRole(null);
    setIsCreating(false);
    fetchRoles();
  };

  const getPermissionSummary = (permissions: Role['permissions']) => {
    const pageCount = Object.keys(permissions).length;
    if (pageCount === 0) return 'No permissions';
    return `${pageCount} page${pageCount === 1 ? '' : 's'}`;
  };

  const selectRole = (role: Role) => {
    setIsCreating(false);
    setEditingRole(role);
  };

  const startCreate = () => {
    setEditingRole(null);
    setIsCreating(true);
  };

  const newRoleButton = (
    <Button onClick={startCreate}>
      <Plus className="w-4 h-4 mr-2" />
      New role
    </Button>
  );

  if (loading) {
    return (
      <SettingsScreen title="Roles" lede={ROLES_LEDE}>
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
        </div>
      </SettingsScreen>
    );
  }

  const editorOpen = isCreating || editingRole !== null;

  return (
    <>
      <SettingsScreen title="Roles" lede={ROLES_LEDE} actions={newRoleButton}>
        <SettingsGroup label="Role list">
          {/* Built-in Admin role - always first, not editable */}
          <div className="flex items-center gap-3 px-4 py-3">
            <Shield className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">Admin</span>
                <Badge variant="outline" className="text-xs">
                  Built-in
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">Full access to all pages and settings</p>
            </div>
          </div>

          {/* Built-in Member role - default for all drive members */}
          <div className="flex items-center gap-3 px-4 py-3">
            <Users className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">Member</span>
                <Badge variant="outline" className="text-xs">
                  Built-in
                </Badge>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Eye className="w-3 h-3" aria-hidden="true" />
                  View only
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                View only · read access to non-private pages
              </p>
            </div>
          </div>

          {roles.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              Create custom roles to define access levels for your team.
            </div>
          ) : (
            roles.map((role) => {
              const selected = editingRole?.id === role.id;
              return (
                <div
                  key={role.id}
                  className={cn('flex items-center gap-3 px-4 py-3', selected && 'bg-muted')}
                >
                  <GripVertical className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />

                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectRole(role)}
                    className="min-w-0 flex-1 rounded-md text-left"
                  >
                    <div className="flex items-center gap-2">
                      <Badge className={getRoleColorClasses(role.color)}>{role.name}</Badge>
                      {role.isDefault && (
                        <Badge variant="outline" className="text-xs">
                          <Star className="w-3 h-3 mr-1" aria-hidden="true" />
                          Default
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {role.description || getPermissionSummary(role.permissions)}
                    </p>
                  </button>

                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${role.name}`}
                    onClick={() => setDeletingRoleId(role.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              );
            })
          )}
        </SettingsGroup>

        {editorOpen && (
          <RoleEditor
            key={editingRole?.id ?? 'new'}
            driveId={driveId}
            role={editingRole}
            onSave={handleRoleSaved}
            onCancel={() => {
              setEditingRole(null);
              setIsCreating(false);
            }}
          />
        )}
      </SettingsScreen>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingRoleId} onOpenChange={() => setDeletingRoleId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Role</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this role? Members with this role will keep their current permissions, but the role assignment will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingRoleId && handleDeleteRole(deletingRoleId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
