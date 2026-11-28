'use client';

import { useState } from 'react';
import { Button } from '@/retained/components/ui/button';
import { Input } from '@/retained/components/ui/input';
import { Label } from '@/retained/components/ui/label';
import { Textarea } from '@/retained/components/ui/textarea';
import { Switch } from '@/retained/components/ui/switch';
import { Checkbox } from '@/retained/components/ui/checkbox';
import { toast } from 'sonner';
import { post, patch } from '@/retained/lib/auth/auth-fetch';
import { ROLE_COLORS } from '@/retained/lib/utils';
import { PermissionsGrid } from '@/retained/components/members/PermissionsGrid';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { LAPSED_LOOSEN_NOTE, useOrgLapsed } from '@/retained/hooks/useOrgLapsed';
import { roleGrantWidens } from '@pagespace/lib/organizations/loosening-core';

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

interface RoleEditorProps {
  driveId: string;
  role?: Role | null;
  onSave: () => void;
  onCancel: () => void;
}

export function RoleEditor({ driveId, role, onSave, onCancel }: RoleEditorProps) {
  const isEditing = !!role;

  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [color, setColor] = useState(role?.color || 'blue');
  const [isDefault, setIsDefault] = useState(role?.isDefault || false);
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(
    () => {
      if (role?.permissions) {
        return new Map(Object.entries(role.permissions));
      }
      return new Map();
    }
  );
  const [driveWidePerms, setDriveWidePerms] = useState<{ canView: boolean; canEdit: boolean; canShare: boolean } | null>(
    role?.driveWidePermissions ?? null
  );
  const [saving, setSaving] = useState(false);
  const driveOrgId = useDriveStore((state) => state.drives.find((drive) => drive.id === driveId)?.orgId ?? null);
  const lapsed = useOrgLapsed(driveOrgId);
  const editedGrant = { permissions: Object.fromEntries(permissions), driveWidePermissions: driveWidePerms };
  const widens = isEditing && role
    ? roleGrantWidens({ permissions: role.permissions, driveWidePermissions: role.driveWidePermissions ?? null }, editedGrant) || (isDefault && !role.isDefault)
    : isDefault;
  const lapsedBlocksSave = lapsed && widens;

  const handlePermissionChange = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
    setPermissions(prev => {
      const newPerms = new Map(prev);
      newPerms.set(pageId, perms);
      return newPerms;
    });
  };

  const handleDriveWideChange = (perm: 'canView' | 'canEdit' | 'canShare', value: boolean) => {
    setDriveWidePerms(prev => {
      const base = prev ?? { canView: false, canEdit: false, canShare: false };
      const next = { ...base };
      if (perm === 'canView' && !value) {
        return null;
      } else if ((perm === 'canEdit' || perm === 'canShare') && value) {
        next.canView = true;
        next[perm] = true;
      } else {
        next[perm] = value;
      }
      return (next.canView || next.canEdit || next.canShare) ? next : null;
    });
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Please enter a name for this role');
      return;
    }

    if (trimmedName.length > 50) {
      toast.error('Role name must be 50 characters or less');
      return;
    }

    setSaving(true);
    try {
      const permissionsObj: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }> = {};
      permissions.forEach((perms, pageId) => {
        // When drive-wide access is active, retain all-false entries as explicit denials —
        // the permission resolver uses canView:false entries to remove pages from the drive-wide grant.
        if (perms.canView || perms.canEdit || perms.canShare || driveWidePerms) {
          permissionsObj[pageId] = perms;
        }
      });

      const roleData = {
        name: name.trim(),
        description: description.trim() || undefined,
        color,
        isDefault,
        permissions: permissionsObj,
        driveWidePermissions: driveWidePerms,
      };

      if (isEditing && role) {
        await patch(`/api/drives/${driveId}/roles/${role.id}`, roleData);
        toast.success('Role updated successfully');
      } else {
        await post(`/api/drives/${driveId}/roles`, roleData);
        toast.success('Role created successfully');
      }

      onSave();
    } catch (error) {
      console.error('Error saving role:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save role');
    } finally {
      setSaving(false);
    }
  };

  const title = isEditing ? `Editing “${role?.name ?? ''}”` : 'New role';

  return (
    <section aria-labelledby="role-editor-title" className="flex flex-col gap-6">
      <h2 id="role-editor-title" className="text-base font-semibold text-foreground">
        {title}
      </h2>

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
          <fieldset className="flex gap-2">
            <legend className="sr-only">Color</legend>
            {ROLE_COLORS.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => setColor(c.name)}
                aria-label={`Select ${c.name} color`}
                aria-pressed={color === c.name}
                className={`w-8 h-8 rounded-full ${c.class} ${
                  color === c.name ? 'ring-2 ring-offset-2 ring-primary' : ''
                }`}
              />
            ))}
          </fieldset>
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

      <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
        <div className="space-y-0.5">
          <Label htmlFor="role-default">Default role</Label>
          <p className="text-sm text-muted-foreground">
            Automatically assign this role to new members
          </p>
        </div>
        <Switch
          id="role-default"
          checked={isDefault}
          onCheckedChange={setIsDefault}
        />
      </div>

      {/* Access level: drive-wide grants, then the per-page Page / View / Edit / Share grid */}
      <div className="space-y-4">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Access level</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Grant the same permission to every non-private page in the drive. Leave unchecked to control access per page below.
            </p>
          </div>
          <div className="flex gap-6">
            {(['canView', 'canEdit', 'canShare'] as const).map((perm) => (
              <label key={perm} className="flex items-center gap-2 cursor-pointer select-none">
                <Checkbox
                  checked={driveWidePerms?.[perm] ?? false}
                  onCheckedChange={(v) => handleDriveWideChange(perm, !!v)}
                />
                <span className="text-sm capitalize">{perm.replace('can', '')}</span>
              </label>
            ))}
          </div>
          {driveWidePerms && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Drive-wide access is active — use per-page settings below to grant private pages or deny specific pages.
            </p>
          )}
        </div>
        <PermissionsGrid
          driveId={driveId}
          permissions={permissions}
          onChange={handlePermissionChange}
        />
      </div>

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        {lapsedBlocksSave && (
          <p className="mr-auto self-center text-xs text-muted-foreground" data-testid="lapsed-loosen-note">
            Widening a role or making it the default is paused. {LAPSED_LOOSEN_NOTE}
          </p>
        )}
        <Button onClick={handleSave} disabled={saving || lapsedBlocksSave}>
          {saving ? 'Saving…' : 'Save role'}
        </Button>
      </div>
    </section>
  );
}
