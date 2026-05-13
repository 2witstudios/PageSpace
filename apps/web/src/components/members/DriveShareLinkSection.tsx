'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Link2, Copy, Trash2 } from 'lucide-react';
import { useShareLink } from '@/hooks/useShareLink';

type DriveRole = 'MEMBER' | 'ADMIN';
interface DriveLink { id: string; role: DriveRole; useCount: number; }
const MSGS = {
  created: 'Invite link created',
  createdAndCopied: 'Invite link created and copied to clipboard',
  copied: 'Invite link copied to clipboard',
  copyFailed: 'Could not copy link to clipboard',
  revoked: 'Invite link revoked',
  createFailed: 'Failed to create invite link',
  revokeFailed: 'Failed to revoke invite link',
};

export function DriveShareLinkSection({ driveId }: { driveId: string }) {
  const [role, setRole] = useState<DriveRole>('MEMBER');
  const { activeLink, rawToken, isLoading, isGenerating, isRevoking, handleGenerate, handleCopy, handleRevoke } =
    useShareLink<DriveLink>({
      apiBase: `/api/drives/${driveId}/share-links`,
      extractLink: (i) => ({ id: i.id as string, role: i.role as DriveRole, useCount: i.useCount as number }),
      getGenerateBody: () => ({ role }),
      buildNewLink: (id) => ({ id, role, useCount: 0 }),
      messages: MSGS,
    });
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2"><Link2 className="h-4 w-4" />Invite link</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Anyone with this link can join the drive (must be signed in).</p>
      </div>
      {isLoading ? (
        <div className="h-8 w-full animate-pulse rounded bg-muted" />
      ) : activeLink ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs capitalize">{activeLink.role.toLowerCase()}</Badge>
            <span className="text-xs text-muted-foreground">Used {activeLink.useCount} {activeLink.useCount === 1 ? 'time' : 'times'}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={handleCopy} disabled={!rawToken}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy link</Button>
            <Button variant="ghost" size="sm" onClick={handleRevoke} disabled={isRevoking} className="text-destructive hover:text-destructive" aria-label="Revoke invite link"><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-sm">Role</span>
            <Select value={role} onValueChange={(v) => setRole(v as DriveRole)}>
              <SelectTrigger className="w-32 h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={handleGenerate} disabled={isGenerating}>
            <Link2 className="mr-1.5 h-3.5 w-3.5" />{isGenerating ? 'Generating…' : 'Generate invite link'}
          </Button>
        </div>
      )}
    </div>
  );
}
