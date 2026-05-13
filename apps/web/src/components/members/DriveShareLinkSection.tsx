'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Link2, Copy, Trash2 } from 'lucide-react';
import { useDriveShareLink, type DriveLink, type DriveRole } from '@/hooks/useDriveShareLink';

export function DriveShareLinkSection({ driveId }: { driveId: string }) {
  const { links, role, setRole, isLoading, isGenerating, revokingId, handleGenerate, handleCopy, handleRevoke } =
    useDriveShareLink(driveId);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2"><Link2 className="h-4 w-4" />Invite links</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Anyone with a link can join the drive (must be signed in).</p>
      </div>

      {isLoading ? (
        <div className="h-8 w-full animate-pulse rounded bg-muted" />
      ) : (
        <>
          {links.length > 0 && (
            <div className="space-y-2">
              {links.map((link: DriveLink) => (
                <div key={link.id} className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs capitalize shrink-0">{link.role.toLowerCase()}</Badge>
                  <span className="text-xs text-muted-foreground flex-1">{link.useCount} {link.useCount === 1 ? 'use' : 'uses'}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => handleCopy(link)}
                    disabled={!link.shareUrl}
                    aria-label={`Copy ${link.role.toLowerCase()} invite link`}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-destructive hover:text-destructive"
                    onClick={() => handleRevoke(link.id)}
                    disabled={revokingId === link.id}
                    aria-label="Revoke invite link"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className={links.length > 0 ? 'flex items-center gap-2 border-t border-gray-200 dark:border-gray-700 pt-3' : 'flex items-center gap-2'}>
            <Select value={role} onValueChange={(v) => setRole(v as DriveRole)}>
              <SelectTrigger className="w-32 h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={handleGenerate} disabled={isGenerating} className="flex-1">
              <Link2 className="mr-1.5 h-3.5 w-3.5" />{isGenerating ? 'Generating…' : 'New invite link'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
