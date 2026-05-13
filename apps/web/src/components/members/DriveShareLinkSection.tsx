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
import { Link2, Copy, Trash2 } from 'lucide-react';
import { post, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

interface ActiveLink {
  id: string;
  role: 'MEMBER' | 'ADMIN';
  useCount: number;
}

interface DriveShareLinkSectionProps {
  driveId: string;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

export function DriveShareLinkSection({ driveId }: DriveShareLinkSectionProps) {
  const [activeLink, setActiveLink] = useState<ActiveLink | null>(null);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [role, setRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadExisting() {
      try {
        const res = await fetch(`/api/drives/${driveId}/share-links`, {
          credentials: 'include',
        });
        if (!res.ok || cancelled) return;
        const data = await res.json() as {
          links: Array<{ id: string; role: 'MEMBER' | 'ADMIN'; useCount: number }>;
        };
        if (!cancelled && data.links.length > 0) {
          const first = data.links[0];
          setActiveLink({ id: first.id, role: first.role, useCount: first.useCount });
        }
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
      setRawToken(data.rawToken);
      setActiveLink({ id: data.id, role, useCount: 0 });
      const copied = await navigator.clipboard.writeText(data.shareUrl).then(() => true).catch(() => false);
      toast.success(copied ? 'Invite link created and copied to clipboard' : 'Invite link created');
    } catch {
      toast.error('Failed to create invite link');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy() {
    if (!rawToken) return;
    const copied = await navigator.clipboard.writeText(`${APP_URL}/s/${rawToken}`).then(() => true).catch(() => false);
    if (copied) toast.success('Invite link copied to clipboard');
    else toast.error('Could not copy link to clipboard');
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

      {isLoading ? (
        <div className="h-8 w-full animate-pulse rounded bg-muted" />
      ) : activeLink ? (
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
              aria-label="Revoke invite link"
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
