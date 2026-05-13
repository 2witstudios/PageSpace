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

type DriveLink = z.infer<typeof DriveLinkSchema>;
export type DriveRole = 'MEMBER' | 'ADMIN';

export function useDriveShareLink(driveId: string) {
  const [activeLink, setActiveLink] = useState<DriveLink | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [role, setRole] = useState<DriveRole>('MEMBER');
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
        const res = await fetch(`/api/drives/${driveId}/share-links`, { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const raw = await res.json();
        const parsed = DriveListResponseSchema.safeParse(raw);
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
  }, [driveId]);

  async function handleGenerate() {
    setIsGenerating(true);
    try {
      const data = await post<{ id: string; rawToken: string; shareUrl: string }>(
        `/api/drives/${driveId}/share-links`,
        { role }
      );
      setShareUrl(data.shareUrl);
      setActiveLink({ id: data.id, role, useCount: 0, shareUrl: data.shareUrl });
      const copied = await navigator.clipboard.writeText(data.shareUrl).then(() => true).catch(() => false);
      toast.success(copied ? 'Invite link created and copied to clipboard' : 'Invite link created');
    } catch {
      toast.error('Failed to create invite link');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy() {
    if (!shareUrl) return;
    const copied = await navigator.clipboard.writeText(shareUrl).then(() => true).catch(() => false);
    if (copied) toast.success('Invite link copied to clipboard');
    else toast.error('Could not copy link to clipboard');
  }

  async function handleRevoke() {
    if (!activeLink) return;
    setIsRevoking(true);
    try {
      await del(`/api/drives/${driveId}/share-links/${activeLink.id}`);
      setActiveLink(null);
      setShareUrl(null);
      toast.success('Invite link revoked');
    } catch {
      toast.error('Failed to revoke invite link');
    } finally {
      setIsRevoking(false);
    }
  }

  return { activeLink, shareUrl, role, setRole, isLoading, isGenerating, isRevoking, handleGenerate, handleCopy, handleRevoke };
}
