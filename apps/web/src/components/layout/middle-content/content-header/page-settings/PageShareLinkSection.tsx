'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Link2, Copy, Trash2 } from 'lucide-react';
import { useShareLink } from '@/hooks/useShareLink';

type PagePerms = Array<'VIEW' | 'EDIT'>;
interface PageLink { id: string; permissions: PagePerms; useCount: number; }
const MSGS = {
  created: 'Link created',
  createdAndCopied: 'Link created and copied to clipboard',
  copied: 'Link copied to clipboard',
  copyFailed: 'Could not copy link to clipboard',
  revoked: 'Link revoked',
  createFailed: 'Failed to create link',
  revokeFailed: 'Failed to revoke link',
};

export function PageShareLinkSection({ pageId }: { pageId: string }) {
  const [includeEdit, setIncludeEdit] = useState(false);
  const { activeLink, rawToken, isLoading, isGenerating, isRevoking, handleGenerate, handleCopy, handleRevoke } =
    useShareLink<PageLink>({
      apiBase: `/api/pages/${pageId}/share-links`,
      extractLink: (i) => ({ id: i.id as string, permissions: i.permissions as PagePerms, useCount: i.useCount as number }),
      getGenerateBody: () => ({ permissions: includeEdit ? ['VIEW', 'EDIT'] : ['VIEW'] }),
      buildNewLink: (id) => ({ id, permissions: includeEdit ? ['VIEW', 'EDIT'] : ['VIEW'], useCount: 0 }),
      messages: MSGS,
    });
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium flex items-center gap-2"><Link2 className="h-4 w-4" />Share link</h4>
      {isLoading ? (
        <div className="h-8 w-full animate-pulse rounded bg-muted" />
      ) : activeLink ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">{activeLink.permissions.includes('EDIT') ? 'View + Edit' : 'View only'}</Badge>
            <span className="text-xs text-muted-foreground">Used {activeLink.useCount} {activeLink.useCount === 1 ? 'time' : 'times'}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={handleCopy} disabled={!rawToken}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy link</Button>
            <Button variant="ghost" size="sm" onClick={handleRevoke} disabled={isRevoking} className="text-destructive hover:text-destructive" aria-label="Revoke share link"><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch id="share-link-edit" checked={includeEdit} onCheckedChange={setIncludeEdit} />
            <Label htmlFor="share-link-edit" className="text-sm cursor-pointer">Allow editing</Label>
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={handleGenerate} disabled={isGenerating}>
            <Link2 className="mr-1.5 h-3.5 w-3.5" />{isGenerating ? 'Generating…' : 'Generate link'}
          </Button>
        </div>
      )}
    </div>
  );
}
