'use client';

import { useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getRoleColorClasses } from '@/lib/utils';
import { patch, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

export interface AppMember {
  id: string;
  tokenId: string;
  name: string | null;
  role: string | null;
  createdAt: Date | string;
  customRole: { id: string; name: string; color: string | null } | null;
}

interface DriveRole {
  id: string;
  name: string;
  color?: string | null;
}

interface AppMemberRowProps {
  app: AppMember;
  driveId: string;
  currentUserRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  driveRoles: DriveRole[];
  onRoleChange: (tokenId: string, updated: Partial<AppMember>) => void;
  onRemove: (tokenId: string) => void;
}

function getRoleBadge(app: AppMember) {
  if (app.role === null) {
    return (
      <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
        Inherits owner
      </Badge>
    );
  }
  if (app.role === 'ADMIN') {
    return (
      <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
        Admin
      </Badge>
    );
  }
  if (app.customRole) {
    return (
      <Badge className={getRoleColorClasses(app.customRole.color ?? undefined)}>
        {app.customRole.name}
      </Badge>
    );
  }
  return (
    <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">
      Member
    </Badge>
  );
}

function currentSelectValue(app: AppMember): string {
  if (app.role === null) return 'INHERIT';
  if (app.role === 'ADMIN') return 'ADMIN';
  if (app.customRole) return app.customRole.id;
  return 'MEMBER';
}

export function AppMemberRow({
  app,
  driveId,
  currentUserRole,
  driveRoles,
  onRoleChange,
  onRemove,
}: AppMemberRowProps) {
  const [saving, setSaving] = useState(false);
  const canManage = currentUserRole === 'OWNER' || currentUserRole === 'ADMIN';
  const displayName = app.name ?? 'Unnamed App';

  const handleRoleSelect = async (value: string) => {
    setSaving(true);
    try {
      const body: { role: 'MEMBER' | 'ADMIN' | null; customRoleId: string | null } =
        value === 'INHERIT'
          ? { role: null, customRoleId: null }
          : value === 'ADMIN'
          ? { role: 'ADMIN', customRoleId: null }
          : value === 'MEMBER'
          ? { role: 'MEMBER', customRoleId: null }
          : { role: 'MEMBER', customRoleId: value };

      await patch(`/api/drives/${driveId}/apps/${app.tokenId}`, body);

      const customRole = value !== 'INHERIT' && value !== 'ADMIN' && value !== 'MEMBER'
        ? (driveRoles.find((r) => r.id === value) ?? null)
        : null;

      onRoleChange(app.tokenId, {
        role: body.role,
        customRole: customRole ? { id: customRole.id, name: customRole.name, color: customRole.color ?? null } : null,
      });
    } catch {
      toast.error('Failed to update app role');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm(`Remove ${displayName} from drive members?`)) return;
    try {
      await del(`/api/drives/${driveId}/apps/${app.tokenId}`);
      onRemove(app.tokenId);
    } catch {
      toast.error('Failed to remove app member');
    }
  };

  return (
    <div className="p-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
      <div className="flex items-center space-x-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <p className="font-medium">{displayName}</p>
            {!canManage && getRoleBadge(app)}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">MCP App</p>
        </div>
      </div>

      <div className="flex items-center space-x-2">
        {canManage ? (
          <Select
            value={currentSelectValue(app)}
            onValueChange={handleRoleSelect}
            disabled={saving}
          >
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="INHERIT">Inherits owner</SelectItem>
              <SelectItem value="ADMIN">Admin</SelectItem>
              <SelectItem value="MEMBER">Member</SelectItem>
              {driveRoles.length > 0 && (
                <>
                  <SelectSeparator />
                  {driveRoles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </>
              )}
            </SelectContent>
          </Select>
        ) : (
          getRoleBadge(app)
        )}

        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            title="Remove App Member"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
