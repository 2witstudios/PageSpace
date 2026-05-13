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

export type PageLink = z.infer<typeof PageLinkSchema>;

export interface ShareLinkPermissions {
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
}

export function usePageShareLink(pageId: string) {
  const [links, setLinks] = useState<PageLink[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLinks([]);

    async function loadExisting() {
      try {
        const res = await fetch(`/api/pages/${pageId}/share-links`, { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const raw = await res.json();
        const parsed = PageListResponseSchema.safeParse(raw);
        if (cancelled || !parsed.success) return;
        setLinks(parsed.data.links);
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
      const newLink: PageLink = { id: data.id, permissions, useCount: 0, shareUrl: data.shareUrl };
      setLinks(prev => [...prev, newLink]);
      const copied = await navigator.clipboard.writeText(data.shareUrl).then(() => true).catch(() => false);
      toast.success(copied ? 'Link created and copied to clipboard' : 'Link created');
    } catch {
      toast.error('Failed to create link');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy(link: PageLink) {
    if (!link.shareUrl) return;
    const copied = await navigator.clipboard.writeText(link.shareUrl).then(() => true).catch(() => false);
    if (copied) toast.success('Link copied to clipboard');
    else toast.error('Could not copy link to clipboard');
  }

  async function handleRevoke(linkId: string) {
    setRevokingId(linkId);
    try {
      await del(`/api/pages/${pageId}/share-links/${linkId}`);
      setLinks(prev => prev.filter(l => l.id !== linkId));
      toast.success('Link revoked');
    } catch {
      toast.error('Failed to revoke link');
    } finally {
      setRevokingId(prev => (prev === linkId ? null : prev));
    }
  }

  return { links, isLoading, isGenerating, revokingId, handleGenerate, handleCopy, handleRevoke };
}
