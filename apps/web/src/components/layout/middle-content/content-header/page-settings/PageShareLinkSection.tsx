'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Link2, Copy, Trash2 } from 'lucide-react';
import { usePageShareLink, type ShareLinkPermissions } from '@/hooks/usePageShareLink';

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
  const {
    activeLink,
    shareUrl,
    isLoading,
    isGenerating,
    isRevoking,
    handleGenerate,
    handleCopy,
    handleRevoke,
  } = usePageShareLink(pageId);

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium flex items-center gap-2">
        <Link2 className="h-4 w-4" />
        Share link
      </h4>

      {isLoading ? (
        <div className="h-8 w-full animate-pulse rounded bg-muted" />
      ) : activeLink ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={shareUrl ?? ''}
              aria-label="Share link URL"
              className="flex-1 h-8 min-w-0 px-2 text-xs font-mono bg-muted rounded border border-input truncate focus:ring-2 focus:ring-ring cursor-text"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={handleCopy}
              disabled={!shareUrl}
              aria-label="Copy share link"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 shrink-0 text-destructive hover:text-destructive"
              onClick={handleRevoke}
              disabled={isRevoking}
              aria-label="Revoke share link"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {permissionLabel(activeLink.permissions)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Used {activeLink.useCount} {activeLink.useCount === 1 ? 'time' : 'times'}
            </span>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => handleGenerate(permissions)}
          disabled={isGenerating}
        >
          <Link2 className="mr-1.5 h-3.5 w-3.5" />
          {isGenerating ? 'Generating…' : 'Generate link'}
        </Button>
      )}
    </div>
  );
}
