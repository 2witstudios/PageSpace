'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Link2, Copy, Trash2, RefreshCw } from 'lucide-react';
import { post, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

interface ActiveLink {
  id: string;
  role: 'MEMBER' | 'ADMIN';
  createdAt: string;
  expiresAt: string | null;
  useCount: number;
}

interface DriveShareLinkSectionProps {
  driveId: string;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

export function DriveShareLinkSection({ driveId }: DriveShareLinkSectionProps) {
  const [activeLink, setActiveLink] = useState<ActiveLink | null | undefined>(undefined);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [role, setRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  useEffect(() => {
    fetchWithAuth(`/api/drives/${driveId}/share-links`)
      .then((res) => res.json())
      .then((data: { links?: ActiveLink[] }) => {
        const first = data.links?.find((l) => l) ?? null;
        setActiveLink(first);
        if (first) setRole(first.role);
      })
      .catch(() => setActiveLink(null));
  }, [driveId]);

  async function handleGenerate() {
    setIsGenerating(true);
    try {
      const data = await post<{ id: string; shareUrl: string }>(
        `/api/drives/${driveId}/share-links`,
        { role }
      );
      const token = data.shareUrl.split('/s/')[1];
      setRawToken(token);
      setActiveLink({ id: data.id, role, createdAt: new Date().toISOString(), expiresAt: null, useCount: 0 });
      await navigator.clipboard.writeText(data.shareUrl).catch(() => undefined);
      toast.success('Invite link created and copied to clipboard');
    } catch {
      toast.error('Failed to create invite link');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy() {
    if (!rawToken) return;
    await navigator.clipboard.writeText(`${APP_URL}/s/${rawToken}`).catch(() => undefined);
    toast.success('Invite link copied to clipboard');
  }

  async function handleRevoke() {
    if (!activeLink) return;
    setIsRevoking(true);
    try {
      await del(`/api/drives/${driveId}/share-links/${activeLink.id}`);
      setActiveLink(null);
      setRawToken(null);
      toast.success('Invite link revoked');
    } catch {
      toast.error('Failed to revoke invite link');
    } finally {
      setIsRevoking(false);
    }
  }

  async function handleRegenerate() {
    if (!activeLink) return;
    setIsRevoking(true);
    try {
      await del(`/api/drives/${driveId}/share-links/${activeLink.id}`);
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
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-sm font-medium flex items-center gap-2 mb-2">
          <Link2 className="h-4 w-4" />
          Invite link
        </h3>
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          Invite link
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Anyone with this link can join the drive (must be signed in).
        </p>
      </div>

      {activeLink ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs capitalize">
              {activeLink.role.toLowerCase()}
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
            <span className="text-sm">Role</span>
            <Select value={role} onValueChange={(v) => setRole(v as 'MEMBER' | 'ADMIN')}>
              <SelectTrigger className="w-32 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleGenerate}
            disabled={isGenerating}
          >
            <Link2 className="mr-1.5 h-3.5 w-3.5" />
            {isGenerating ? 'Generating…' : 'Generate invite link'}
          </Button>
        </div>
      )}
    </div>
  );
}
