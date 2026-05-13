'use client';

import { useState, useEffect } from 'react';
import { z } from 'zod';
import { post, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

const PageLinkSchema = z.object({
  id: z.string(),
  permissions: z.array(z.enum(['VIEW', 'EDIT', 'SHARE', 'DELETE'])),
  useCount: z.number(),
  shareUrl: z.string().nullable(),
});

const PageListResponseSchema = z.object({
  links: z.array(PageLinkSchema),
});

type PageLink = z.infer<typeof PageLinkSchema>;

export interface ShareLinkPermissions {
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
}

export function usePageShareLink(pageId: string) {
  const [activeLink, setActiveLink] = useState<PageLink | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setActiveLink(null);
    setShareUrl(null);

    async function loadExisting() {
      try {
        const res = await fetch(`/api/pages/${pageId}/share-links`, { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const raw = await res.json();
        const parsed = PageListResponseSchema.safeParse(raw);
        if (cancelled || !parsed.success || parsed.data.links.length === 0) return;
        const link = parsed.data.links[0];
        setActiveLink(link);
        setShareUrl(link.shareUrl);
      } catch {
        // silently fail — user can still generate a new link
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadExisting();
    return () => { cancelled = true; };
  }, [pageId]);

  async function handleGenerate(perms: ShareLinkPermissions) {
    setIsGenerating(true);
    const permissions: Array<'VIEW' | 'EDIT' | 'SHARE' | 'DELETE'> = ['VIEW'];
    if (perms.canEdit)   permissions.push('EDIT');
    if (perms.canShare)  permissions.push('SHARE');
    if (perms.canDelete) permissions.push('DELETE');
    try {
      const data = await post<{ id: string; rawToken: string; shareUrl: string }>(
        `/api/pages/${pageId}/share-links`,
        { permissions }
      );
      setShareUrl(data.shareUrl);
      setActiveLink({ id: data.id, permissions, useCount: 0, shareUrl: data.shareUrl });
      const copied = await navigator.clipboard.writeText(data.shareUrl).then(() => true).catch(() => false);
      toast.success(copied ? 'Link created and copied to clipboard' : 'Link created');
    } catch {
      toast.error('Failed to create link');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy() {
    if (!shareUrl) return;
    const copied = await navigator.clipboard.writeText(shareUrl).then(() => true).catch(() => false);
    if (copied) toast.success('Link copied to clipboard');
    else toast.error('Could not copy link to clipboard');
  }

  async function handleRevoke() {
    if (!activeLink) return;
    setIsRevoking(true);
    try {
      await del(`/api/pages/${pageId}/share-links/${activeLink.id}`);
      setActiveLink(null);
      setShareUrl(null);
      toast.success('Link revoked');
    } catch {
      toast.error('Failed to revoke link');
    } finally {
      setIsRevoking(false);
    }
  }

  return { activeLink, shareUrl, isLoading, isGenerating, isRevoking, handleGenerate, handleCopy, handleRevoke };
}
