'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Link2, Copy, Trash2, RefreshCw } from 'lucide-react';
import { post, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

interface ActiveLink {
  id: string;
  permissions: Array<'VIEW' | 'EDIT'>;
  createdAt: string;
  expiresAt: string | null;
  useCount: number;
}

interface PageShareLinkSectionProps {
  pageId: string;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

export function PageShareLinkSection({ pageId }: PageShareLinkSectionProps) {
  const [activeLink, setActiveLink] = useState<ActiveLink | null | undefined>(undefined);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [includeEdit, setIncludeEdit] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  useEffect(() => {
    fetchWithAuth(`/api/pages/${pageId}/share-links`)
      .then((res) => res.json())
      .then((data: { links?: ActiveLink[] }) => {
        const first = data.links?.find((l) => l) ?? null;
        setActiveLink(first);
        if (first) {
          setIncludeEdit(first.permissions.includes('EDIT'));
        }
      })
      .catch(() => setActiveLink(null));
  }, [pageId]);

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
        createdAt: new Date().toISOString(),
        expiresAt: null,
        useCount: 0,
      };
      setActiveLink(link);
      await navigator.clipboard.writeText(data.shareUrl).catch(() => undefined);
      toast.success('Link created and copied to clipboard');
    } catch {
      toast.error('Failed to create link');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy() {
    if (!rawToken) return;
    await navigator.clipboard.writeText(`${APP_URL}/s/${rawToken}`).catch(() => undefined);
    toast.success('Link copied to clipboard');
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

  async function handleRegenerate() {
    if (!activeLink) return;
    setIsRevoking(true);
    try {
      await del(`/api/pages/${pageId}/share-links/${activeLink.id}`);
      setActiveLink(null);
      setRawToken(null);
    } catch {
      toast.error('Failed to revoke existing link');
      return;
    } finally {
      setIsRevoking(false);
    }
    await handleGenerate();
  }

  if (activeLink === undefined) {
    return (
      <div className="space-y-2">
        <h4 className="text-sm font-medium flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          Share link
        </h4>
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    );
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
            {rawToken ? (
              <Button variant="outline" size="sm" className="flex-1" onClick={handleCopy}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy link
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={handleRegenerate}
                disabled={isRevoking || isGenerating}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {isRevoking || isGenerating ? 'Working…' : 'Regenerate'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRevoke}
              disabled={isRevoking}
              className="text-destructive hover:text-destructive"
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
