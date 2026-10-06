'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { del } from '@/lib/auth/auth-fetch';

/** `GET /api/drives/[driveId]/members` guests[] (D-OW-24): a page-link guest and the pages it holds here. */
export interface PageLinkGuest {
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  pages: { pageId: string; title: string; role: 'view' | 'edit'; expiresAt: string | null }[];
}

const initialsOf = (name: string) => name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);

/**
 * Page-link guests (Spec UI-5, DRV-8, D-OW-24; canvas v9 DriveMembers): people outside the org
 * who joined a single page through a share link. They are not members and hold no seat. The
 * route lists them only for the drive lead and admins (an empty list for anyone else), so this
 * section renders nothing for a plain member. Revoke removes one page's grant.
 */
export function PageLinkGuestsSection({ guests, orgName, onChanged }: { guests: PageLinkGuest[]; orgName: string | null; onChanged: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  if (guests.length === 0) return null;

  const revoke = async (guest: PageLinkGuest, pageId: string) => {
    setPending(`${guest.userId}:${pageId}`);
    try {
      await del(`/api/pages/${pageId}/permissions`, { userId: guest.userId });
      toast.success(`${guest.displayName} can no longer open that page`);
      onChanged();
    } catch {
      toast.error('The page access could not be revoked. Try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <section data-testid="page-link-guests">
      <div className="mb-3">
        <h2 className="text-lg font-semibold">Page-link guests ({guests.length})</h2>
        <p className="text-sm text-muted-foreground">
          People outside {orgName ?? 'this drive'} who joined a single page through a share link. Only the drive lead and admins see this list.
        </p>
      </div>
      <div className="divide-y rounded-lg border bg-card">
        {guests.flatMap((guest) =>
          guest.pages.map((page) => (
            <div key={`${guest.userId}:${page.pageId}`} className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap">
              <Avatar>
                <AvatarImage src={guest.avatarUrl ?? undefined} alt={guest.displayName} />
                <AvatarFallback>{initialsOf(guest.displayName)}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 font-medium">
                  {guest.displayName}
                  <GuestBadge />
                </span>
                {guest.username && <span className="text-sm text-muted-foreground">@{guest.username}</span>}
              </div>
              <span className="max-w-[12rem] truncate text-sm text-muted-foreground" title={page.title}>{page.title}</span>
              <span className="w-12 text-sm text-muted-foreground">{page.role === 'edit' ? 'Edit' : 'View'}</span>
              <span className="w-24 text-sm tabular-nums text-muted-foreground">
                {page.expiresAt ? new Date(page.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'No expiry'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={pending !== null}
                onClick={() => void revoke(guest, page.pageId)}
              >
                Revoke
              </Button>
            </div>
          )),
        )}
      </div>
    </section>
  );
}

/** The Guest label (DRV-8): a person on this drive who is not in its organization. */
export function GuestBadge() {
  return (
    <Badge className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">Guest</Badge>
  );
}

const SOURCE_LABELS = { lead: 'Lead', org: 'Org', invite: 'Invite' } as const;

/** Where a member's access comes from on an org drive (UI-5): the lead, the org (Open or org admin), or a direct invite. */
export function MemberSourceBadge({ source }: { source: keyof typeof SOURCE_LABELS }) {
  return <Badge variant="outline" className="font-normal">{SOURCE_LABELS[source]}</Badge>;
}

/** The legend under the member list on an org drive. */
export function MemberSourceLegend({ orgName }: { orgName: string | null }) {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="member-source-legend">
      <span><b>Lead</b> · the drive lead</span>
      <span><b>Org</b> · a {orgName ?? 'organization'} member with access through Open visibility or as an org admin</span>
      <span><b>Invite</b> · added to this drive directly</span>
    </p>
  );
}
