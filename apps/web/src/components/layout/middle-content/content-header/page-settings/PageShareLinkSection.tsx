'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Link2, Copy, Trash2 } from 'lucide-react';
import { usePageShareLink, type PageLink, type ShareLinkPermissions } from '@/hooks/usePageShareLink';

function permissionLabel(permissions: string[]): string {
  const labels: string[] = [];
  if (permissions.includes('VIEW'))   labels.push('View');
  if (permissions.includes('EDIT'))   labels.push('Edit');
  if (permissions.includes('SHARE'))  labels.push('Share');
  if (permissions.includes('DELETE')) labels.push('Delete');
  if (labels.length === 1) return 'View only';
  return labels.join(', ');
}

interface PageShareLinkSectionProps {
  pageId: string;
  permissions: ShareLinkPermissions;
}

export function PageShareLinkSection({ pageId, permissions }: PageShareLinkSectionProps) {
  const { links, isLoading, isGenerating, revokingId, handleGenerate, handleCopy, handleRevoke } =
    usePageShareLink(pageId);

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium flex items-center gap-2">
        <Link2 className="h-4 w-4" />
        Share links
      </h4>

      {isLoading ? (
        <div className="h-8 w-full animate-pulse rounded bg-muted" />
      ) : (
        <>
          {links.length > 0 && (
            <div className="space-y-2">
              {links.map((link: PageLink) => (
                <div key={link.id} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {permissionLabel(link.permissions)}
                    </Badge>
                    <input
                      type="text"
                      readOnly
                      value={link.shareUrl ?? ''}
                      aria-label="Share link URL"
                      className="flex-1 h-7 min-w-0 px-2 text-xs font-mono bg-muted rounded border border-input truncate focus:ring-2 focus:ring-ring cursor-text"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 shrink-0"
                      onClick={() => handleCopy(link)}
                      disabled={!link.shareUrl}
                      aria-label="Copy share link"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 shrink-0 text-destructive hover:text-destructive"
                      onClick={() => handleRevoke(link.id)}
                      disabled={revokingId === link.id}
                      aria-label="Revoke share link"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground pl-1">
                    {link.useCount} {link.useCount === 1 ? 'use' : 'uses'}
                  </p>
                </div>
              ))}
            </div>
          )}

          <div className={links.length > 0 ? 'border-t border-gray-200 dark:border-gray-700 pt-3' : ''}>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => handleGenerate(permissions)}
              disabled={isGenerating || !permissions.canView}
              title={!permissions.canView ? 'Select at least View permission to generate a link' : undefined}
            >
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              {isGenerating ? 'Generating…' : 'New share link'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
