'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Link2, Copy, Trash2 } from 'lucide-react';
import {
  useDriveShareLink,
  type DriveLink,
  type SelectedShareRole,
} from '@/hooks/useDriveShareLink';
import { getRoleColorClasses } from '@/lib/utils';

function selectedRoleToSelectValue(role: SelectedShareRole): string {
  if (role.kind === 'admin') return 'admin';
  if (role.kind === 'custom') return role.customRoleId;
  return 'member';
}

function linkLabel(link: DriveLink): { text: string; classes: string } {
  if (link.role === 'ADMIN') {
    return {
      text: 'Admin',
      classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    };
  }
  if (link.customRoleName) {
    return {
      text: link.customRoleName,
      classes: getRoleColorClasses(link.customRoleColor ?? undefined),
    };
  }
  return {
    text: 'Member',
    classes: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  };
}

export function DriveShareLinkSection({ driveId }: { driveId: string }) {
  const {
    links,
    customRoles,
    selectedRole,
    setSelectedRole,
    isLoading,
    isGenerating,
    revokingId,
    handleGenerate,
    handleCopy,
    handleRevoke,
  } = useDriveShareLink(driveId);

  const handleRoleChange = (value: string) => {
    if (value === 'admin') {
      setSelectedRole({ kind: 'admin' });
    } else if (value === 'member') {
      setSelectedRole({ kind: 'member' });
    } else {
      setSelectedRole({ kind: 'custom', customRoleId: value });
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          Invite links
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Anyone with a link can join the drive with the selected role (must be signed in).
        </p>
      </div>

      {isLoading ? (
        <div className="h-8 w-full animate-pulse rounded bg-muted" />
      ) : (
        <>
          {links.length > 0 && (
            <div className="space-y-2">
              {links.map((link: DriveLink) => {
                const label = linkLabel(link);
                return (
                  <div key={link.id} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge className={`text-xs shrink-0 ${label.classes}`}>{label.text}</Badge>
                      <input
                        type="text"
                        readOnly
                        value={link.shareUrl ?? ''}
                        aria-label={`${label.text} invite link URL`}
                        className="flex-1 h-7 min-w-0 px-2 text-xs font-mono bg-muted rounded border border-input truncate focus:ring-2 focus:ring-ring cursor-text"
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 shrink-0"
                        onClick={() => handleCopy(link)}
                        disabled={!link.shareUrl}
                        aria-label={`Copy ${label.text} invite link`}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 shrink-0 text-destructive hover:text-destructive"
                        onClick={() => handleRevoke(link.id)}
                        disabled={revokingId === link.id}
                        aria-label="Revoke invite link"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground pl-1">
                      {link.useCount} {link.useCount === 1 ? 'use' : 'uses'}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          <div
            className={
              links.length > 0
                ? 'flex items-center gap-2 border-t border-gray-200 dark:border-gray-700 pt-3'
                : 'flex items-center gap-2'
            }
          >
            <Select value={selectedRoleToSelectValue(selectedRole)} onValueChange={handleRoleChange}>
              <SelectTrigger className="w-40 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                      Admin
                    </Badge>
                    <span className="text-xs text-muted-foreground">Full access</span>
                  </div>
                </SelectItem>

                {customRoles.length > 0 && <SelectSeparator />}

                {customRoles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    <div className="flex items-center gap-2">
                      <Badge className={getRoleColorClasses(role.color ?? undefined)}>
                        {role.name}
                      </Badge>
                      {role.isDefault && (
                        <span className="text-xs text-muted-foreground">Default</span>
                      )}
                    </div>
                  </SelectItem>
                ))}

                <SelectSeparator />

                <SelectItem value="member">
                  <span className="text-muted-foreground">Member (no role)</span>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerate}
              disabled={isGenerating}
              className="flex-1"
            >
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              {isGenerating ? 'Generating…' : 'New invite link'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
