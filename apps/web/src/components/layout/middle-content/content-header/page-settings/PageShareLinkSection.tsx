'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Link2, Copy, Trash2 } from 'lucide-react';
import { post, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

interface ActiveLink {
  id: string;
  permissions: Array<'VIEW' | 'EDIT'>;
  useCount: number;
}

interface PageShareLinkSectionProps {
  pageId: string;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

export function PageShareLinkSection({ pageId }: PageShareLinkSectionProps) {
  const [activeLink, setActiveLink] = useState<ActiveLink | null>(null);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [includeEdit, setIncludeEdit] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  async function handleGenerate() {
    setIsGenerating(true);
    try {
      const permissions: Array<'VIEW' | 'EDIT'> = includeEdit ? ['VIEW', 'EDIT'] : ['VIEW'];
      const data = await post<{ id: string; shareUrl: string }>(
        `/api/pages/${pageId}/share-links`,
        { permissions }
      );
      const token = data.shareUrl.split('/s/')[1];
      setRawToken(token);
      const link: ActiveLink = {
        id: data.id,
        permissions,
        useCount: 0,
      };
      setActiveLink(link);
      const copied = await navigator.clipboard.writeText(data.shareUrl).then(() => true).catch(() => false);
      toast.success(copied ? 'Link created and copied to clipboard' : 'Link created');
    } catch {
      toast.error('Failed to create link');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy() {
    if (!rawToken) return;
    const copied = await navigator.clipboard.writeText(`${APP_URL}/s/${rawToken}`).then(() => true).catch(() => false);
    if (copied) toast.success('Link copied to clipboard');
    else toast.error('Could not copy link to clipboard');
  }

  async function handleRevoke() {
    if (!activeLink) return;
    setIsRevoking(true);
    try {
      await del(`/api/pages/${pageId}/share-links/${activeLink.id}`);
      setActiveLink(null);
      setRawToken(null);
      toast.success('Link revoked');
    } catch {
      toast.error('Failed to revoke link');
    } finally {
      setIsRevoking(false);
    }
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium flex items-center gap-2">
        <Link2 className="h-4 w-4" />
        Share link
      </h4>

      {activeLink ? (
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
            <Button variant="outline" size="sm" className="flex-1" onClick={handleCopy} disabled={!rawToken}>
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
