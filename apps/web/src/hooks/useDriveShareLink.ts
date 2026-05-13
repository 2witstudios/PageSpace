'use client';

import { useState, useEffect } from 'react';
import { z } from 'zod';
import { post, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

const DriveLinkSchema = z.object({
  id: z.string(),
  role: z.enum(['MEMBER', 'ADMIN']),
  useCount: z.number(),
  shareUrl: z.string().nullable(),
});

const DriveListResponseSchema = z.object({
  links: z.array(DriveLinkSchema),
});

export type DriveLink = z.infer<typeof DriveLinkSchema>;
export type DriveRole = 'MEMBER' | 'ADMIN';

export function useDriveShareLink(driveId: string) {
  const [links, setLinks] = useState<DriveLink[]>([]);
  const [role, setRole] = useState<DriveRole>('MEMBER');
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLinks([]);

    async function loadExisting() {
      try {
        const res = await fetch(`/api/drives/${driveId}/share-links`, { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const raw = await res.json();
        const parsed = DriveListResponseSchema.safeParse(raw);
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
  }, [driveId]);

  async function handleGenerate() {
    setIsGenerating(true);
    try {
      const data = await post<{ id: string; rawToken: string; shareUrl: string }>(
        `/api/drives/${driveId}/share-links`,
        { role }
      );
      const newLink: DriveLink = { id: data.id, role, useCount: 0, shareUrl: data.shareUrl };
      setLinks(prev => [...prev, newLink]);
      const copied = await navigator.clipboard.writeText(data.shareUrl).then(() => true).catch(() => false);
      toast.success(copied ? 'Invite link created and copied to clipboard' : 'Invite link created');
    } catch {
      toast.error('Failed to create invite link');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy(link: DriveLink) {
    if (!link.shareUrl) return;
    const copied = await navigator.clipboard.writeText(link.shareUrl).then(() => true).catch(() => false);
    if (copied) toast.success('Invite link copied to clipboard');
    else toast.error('Could not copy link to clipboard');
  }

  async function handleRevoke(linkId: string) {
    setRevokingId(linkId);
    try {
      await del(`/api/drives/${driveId}/share-links/${linkId}`);
      setLinks(prev => prev.filter(l => l.id !== linkId));
      toast.success('Invite link revoked');
    } catch {
      toast.error('Failed to revoke invite link');
    } finally {
      setRevokingId(null);
    }
  }

  return { links, role, setRole, isLoading, isGenerating, revokingId, handleGenerate, handleCopy, handleRevoke };
}
