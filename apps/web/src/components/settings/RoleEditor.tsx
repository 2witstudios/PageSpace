'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ChevronLeft, Save } from 'lucide-react';
import { useToast } from '@/hooks/useToast';
import { post, patch } from '@/lib/auth/auth-fetch';
import { ROLE_COLORS } from '@/lib/utils';
import { PermissionsGrid } from '@/components/members/PermissionsGrid';

interface Role {
  id: string;
  name: string;
  description?: string;
  color?: string;
  isDefault: boolean;
  permissions: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
  position: number;
}

interface RoleEditorProps {
  driveId: string;
  role?: Role | null;
  onSave: () => void;
  onCancel: () => void;
}

export function RoleEditor({ driveId, role, onSave, onCancel }: RoleEditorProps) {
  const isEditing = !!role;
  const { toast } = useToast();

  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [color, setColor] = useState(role?.color || 'blue');
  const [isDefault, setIsDefault] = useState(role?.isDefault || false);
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(
    () => {
      // Initialize from role's permissions if editing
      if (role?.permissions) {
        return new Map(Object.entries(role.permissions));
      }
      return new Map();
    }
  );
  const [saving, setSaving] = useState(false);

  const handlePermissionChange = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
    setPermissions(prev => {
      const newPerms = new Map(prev);
      newPerms.set(pageId, perms);
      return newPerms;
    });
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast({
        title: 'Name required',
        description: 'Please enter a name for this role',
        variant: 'destructive',
      });
      return;
    }

    if (trimmedName.length > 50) {
      toast({
        title: 'Name too long',
        description: 'Role name must be 50 characters or less',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      // Convert Map to object for JSON - only include pages with at least one permission
      const permissionsObj: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }> = {};
      permissions.forEach((perms, pageId) => {
        if (perms.canView || perms.canEdit || perms.canShare) {
          permissionsObj[pageId] = perms;
        }
      });

      const roleData = {
        name: name.trim(),
        description: description.trim() || undefined,
        color,
        isDefault,
        permissions: permissionsObj,
      };

      if (isEditing && role) {
        await patch(`/api/drives/${driveId}/roles/${role.id}`, roleData);
        toast({
          title: 'Success',
          description: 'Role updated successfully',
        });
      } else {
        await post(`/api/drives/${driveId}/roles`, roleData);
        toast({
          title: 'Success',
          description: 'Role created successfully',
        });
      }

      onSave();
    } catch (error) {
      console.error('Error saving role:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save role',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <ChevronLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
        <h2 className="text-xl font-semibold">
          {isEditing ? 'Edit Role' : 'Create Role'}
        </h2>
      </div>

      {/* Role Details */}
      <Card>
        <CardHeader>
          <CardTitle>Role Details</CardTitle>
          <CardDescription>
            Define the name and appearance of this role
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g., Editor, Viewer, Contributor"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={50}
              />
            </div>
            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex gap-2">
                {ROLE_COLORS.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => setColor(c.name)}
                    aria-label={`Select ${c.name} color`}
                    aria-pressed={color === c.name}
                    className={`w-8 h-8 rounded-full ${c.class} ${
                      color === c.name ? 'ring-2 ring-offset-2 ring-primary' : ''
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              placeholder="Describe what this role is for..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label>Default Role</Label>
              <p className="text-sm text-muted-foreground">
                Automatically assign this role to new members
              </p>
            </div>
            <Switch
              checked={isDefault}
              onCheckedChange={setIsDefault}
            />
          </div>
        </CardContent>
      </Card>

      {/* Page Permissions */}
      <Card>
        <CardHeader>
          <CardTitle>Page Permissions</CardTitle>
          <CardDescription>
            Select which pages members with this role can access
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

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          <Save className="w-4 h-4 mr-2" />
          {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Role'}
        </Button>
      </div>
    </div>
  );
}
