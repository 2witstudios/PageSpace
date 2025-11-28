'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Plus, Pencil, Trash2, GripVertical, Star, Shield } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { fetchWithAuth, del } from '@/lib/auth/auth-fetch';
import { getRoleColorClasses } from '@/lib/utils';
import { RoleEditor } from './RoleEditor';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface Role {
  id: string;
  name: string;
  description?: string;
  color?: string;
  isDefault: boolean;
  permissions: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
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
  const { toast } = useToast();

  const fetchRoles = async () => {
    try {
      const response = await fetchWithAuth(`/api/drives/${driveId}/roles`);
      if (!response.ok) throw new Error('Failed to fetch roles');
      const data = await response.json();
      setRoles(data.roles || []);
    } catch (error) {
      console.error('Error fetching roles:', error);
      toast({
        title: 'Error',
        description: 'Failed to load roles',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRoles();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveId]);

  const handleDeleteRole = async (roleId: string) => {
    try {
      await del(`/api/drives/${driveId}/roles/${roleId}`);
      toast({
        title: 'Success',
        description: 'Role deleted successfully',
      });
      fetchRoles();
    } catch (error) {
      console.error('Error deleting role:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete role',
        variant: 'destructive',
      });
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

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>Loading roles...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show editor if creating or editing
  if (isCreating || editingRole) {
    return (
      <RoleEditor
        driveId={driveId}
        role={editingRole}
        onSave={handleRoleSaved}
        onCancel={() => {
          setEditingRole(null);
          setIsCreating(false);
        }}
      />
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Roles</CardTitle>
              <CardDescription>
                Create custom roles to define access levels for drive members
              </CardDescription>
            </div>
            <Button onClick={() => setIsCreating(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Create Role
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {/* Built-in Admin role - always first, not editable */}
            <div className="flex items-center gap-3 p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20">
              <div className="w-4 h-4 flex items-center justify-center">
                <Shield className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                    Admin
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    Built-in
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Full access to all pages and settings. Cannot be modified.
                </p>
              </div>

              <div className="w-[72px]" /> {/* Spacer for action buttons alignment */}
            </div>

            {roles.length === 0 ? (
              <div className="text-center py-8 border border-dashed border-border rounded-lg">
                <p className="text-muted-foreground mb-4">
                  Create custom roles to define access levels for your team.
                </p>
                <Button variant="outline" onClick={() => setIsCreating(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Role
                </Button>
              </div>
            ) : (
              roles.map((role) => (
                <div
                  key={role.id}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                >
                  <GripVertical className="w-4 h-4 text-muted-foreground cursor-grab" />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge className={getRoleColorClasses(role.color)}>
                        {role.name}
                      </Badge>
                      {role.isDefault && (
                        <Badge variant="outline" className="text-xs">
                          <Star className="w-3 h-3 mr-1" />
                          Default
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground truncate">
                      {role.description || getPermissionSummary(role.permissions)}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setEditingRole(role)}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeletingRoleId(role.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

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
