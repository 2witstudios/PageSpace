'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Link2, Copy, Trash2 } from 'lucide-react';
import { usePageShareLink } from '@/hooks/usePageShareLink';

export function PageShareLinkSection({ pageId }: { pageId: string }) {
  const {
    activeLink,
    shareUrl,
    includeEdit,
    setIncludeEdit,
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
            <Badge variant="secondary" className="text-xs">
              {activeLink.permissions.includes('EDIT') ? 'View + Edit' : 'View only'}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Used {activeLink.useCount} {activeLink.useCount === 1 ? 'time' : 'times'}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleCopy}
              disabled={!shareUrl}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Copy link
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRevoke}
              disabled={isRevoking}
              className="text-destructive hover:text-destructive"
              aria-label="Revoke share link"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              id="share-link-edit"
              checked={includeEdit}
              onCheckedChange={setIncludeEdit}
            />
            <Label htmlFor="share-link-edit" className="text-sm cursor-pointer">
              Allow editing
            </Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleGenerate}
            disabled={isGenerating}
          >
            <Link2 className="mr-1.5 h-3.5 w-3.5" />
            {isGenerating ? 'Generating…' : 'Generate link'}
          </Button>
        </div>
      )}
    </div>
  );
}
