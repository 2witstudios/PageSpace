'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Settings } from 'lucide-react';
import { orgDriveSummaryCopy } from '@pagespace/lib/billing/wallet-surface';
import type { Drive } from '@pagespace/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { OrgMark } from '@/components/orgs/OrgMark';
import { del, fetchWithAuth, patch, put } from '@/lib/auth/auth-fetch';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { useDriveWallet } from '@/hooks/useDriveWallet';
import { useMyOrganizations, type MyOrganization } from '@/hooks/useMyOrganizations';
import { cn } from '@/lib/utils';
import { visibilityChangeAllowed } from '@/lib/orgs/org-lapse';

type Visibility = 'OPEN' | 'RESTRICTED' | 'PRIVATE';

const VISIBILITY: { value: Visibility; label: string; hint: (org: string) => string }[] = [
  { value: 'OPEN', label: 'Open', hint: () => "Every org member can find and open it with this drive's default role. No invite needed." },
  { value: 'RESTRICTED', label: 'Restricted', hint: () => "Listed in the org's Drives directory; members ask to join and the lead approves." },
  { value: 'PRIVATE', label: 'Private', hint: () => 'Invite only. Org admins can still manage it; that is recorded.' },
];

interface OrgMemberRow {
  userId: string;
  name: string;
  email: string;
}

const membersFetcher = async (url: string): Promise<OrgMemberRow[]> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) return [];
  return ((await response.json()) as { members?: OrgMemberRow[] }).members ?? [];
};

/**
 * The Organization card on Drive Settings › General (Spec UI-4, DRV-2, DRV-4; canvas v9
 * DriveGeneral): who owns and pays for the drive, which org members can see it, the drive lead,
 * and moving the drive into or out of an org. Visibility changes broadcast `drive:updated`, which
 * refetches the drive list, so this card follows them live.
 */
export function OrgDriveCard({ drive, leadName, onChanged }: { drive: Drive; leadName: string | null; onChanged: () => void }) {
  const { organizations, orgById } = useMyOrganizations();
  const org = orgById(drive.orgId);
  if (drive.orgId) {
    return org ? <OrgOwnedCard drive={drive} org={org} leadName={leadName} onChanged={onChanged} /> : null;
  }
  return drive.isOwned && drive.kind !== 'HOME' && organizations.length > 0
    ? <MoveInCard drive={drive} organizations={organizations} onChanged={onChanged} />
    : null;
}

function OrgOwnedCard({ drive, org, leadName, onChanged }: { drive: Drive; org: MyOrganization; leadName: string | null; onChanged: () => void }) {
  const isOrgAdmin = org.role === 'OWNER' || org.role === 'ADMIN';
  // [D-OW-33] while the org is unpaid this drive may only be made less open, and its lead stays as is.
  const lapsed = org.lapsed === true;
  const mayEdit = isOrgAdmin || drive.isOwned;
  const { wallet } = useDriveWallet(drive.id);
  const { data: orgMembers } = useSWR(mayEdit ? `/api/orgs/${org.id}/members` : null, membersFetcher, { revalidateOnFocus: false });
  const [pending, setPending] = useState(false);
  const [moveOutOpen, setMoveOutOpen] = useState(false);
  const [moveOutError, setMoveOutError] = useState<string | null>(null);
  const visibility: Visibility = drive.orgVisibility ?? 'OPEN';

  /** Runs a change; the refusal copy when it failed (also toasted), null when it went through. */
  const run = async (action: () => Promise<unknown>, success: string, failure: string): Promise<string | null> => {
    setPending(true);
    try {
      await action();
      toast.success(success);
      onChanged();
      return null;
    } catch (error) {
      const message = orgErrorMessage(error, failure);
      toast.error(message);
      return message;
    } finally {
      setPending(false);
    }
  };

  // The dialog closes only once the move went through; a refusal stays in it so the choice can be retried.
  const moveOut = async (implicitMembers: 'keep' | 'remove') => {
    setMoveOutError(null);
    const failed = await run(() => del(`/api/drives/${drive.id}/org`, { implicitMembers }), `${drive.name} moved out`, 'The drive could not be moved.');
    if (failed) setMoveOutError(failed);
    else setMoveOutOpen(false);
  };

  const summary = orgDriveSummaryCopy({
    orgName: org.name,
    wallet: wallet
      ? {
          allocationCredits: 'allocationCredits' in wallet ? wallet.allocationCredits : null,
          spentCredits: 'spentCredits' in wallet ? wallet.spentCredits : null,
          fallbackRule: 'fallbackRule' in wallet ? wallet.fallbackRule : null,
        }
      : null,
  });

  return (
    <Card data-testid="org-drive-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Organization</CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/orgs/${org.id}/settings`}>
              Org settings <Settings className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
        <CardDescription>This drive belongs to an organization, not a person.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <OrgMark name={org.name} avatarUrl={org.avatarUrl} size="lg" decorative />
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Owned by {org.name}</span>
            <span className="text-xs text-muted-foreground">{summary}</span>
          </div>
        </div>
        <Separator />
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Who in {org.name} can see this drive</span>
          <div role="radiogroup" aria-label="Visibility" className="flex flex-col gap-2">
            {VISIBILITY.map((v) => (
              <button
                key={v.value}
                type="button"
                role="radio"
                aria-checked={visibility === v.value}
                disabled={!mayEdit || pending || !visibilityChangeAllowed(lapsed, visibility, v.value)}
                onClick={() => visibility !== v.value && void run(() => patch(`/api/drives/${drive.id}/org`, { orgVisibility: v.value }), `${drive.name} is now ${v.label}`, 'The visibility could not be changed.')}
                className={cn('flex flex-col gap-0.5 rounded-lg border px-3.5 py-3 text-left transition-colors disabled:cursor-default', visibility === v.value ? 'border-primary bg-primary/10' : 'hover:bg-accent disabled:hover:bg-transparent')}
              >
                <span className="text-sm font-medium">{v.label}</span>
                <span className="text-xs text-muted-foreground">{v.hint(org.name)}</span>
              </button>
            ))}
          </div>
        </div>
        {lapsed && mayEdit && (
          <p className="text-xs text-muted-foreground" data-testid="lapsed-loosen-note">
            Opening this drive further and changing its lead are paused while {org.name} is unpaid. Making it less open still works.
          </p>
        )}
        <Separator />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Drive lead</span>
            <span className="text-xs text-muted-foreground">Has the Owner role here. Can be any org member.</span>
          </div>
          {mayEdit && orgMembers && orgMembers.length > 0 ? (
            <Select
              value={drive.ownerId}
              disabled={pending || lapsed}
              onValueChange={(userId) => void run(() => put(`/api/drives/${drive.id}/org/lead`, { userId }), 'Drive lead changed', 'The drive lead could not be changed.')}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Drive lead"><SelectValue placeholder={leadName ?? 'Drive lead'} /></SelectTrigger>
              <SelectContent>
                {orgMembers.map((m) => <SelectItem key={m.userId} value={m.userId}>{m.name || m.email}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-sm">{leadName ?? '—'}</span>
          )}
        </div>
        {isOrgAdmin && (
          <>
            <Separator />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs text-muted-foreground">Move this drive out of {org.name} to its lead. Storage and AI then bill the lead.</span>
              <Button variant="outline" size="sm" disabled={pending} onClick={() => setMoveOutOpen(true)}>Move out of {org.name}</Button>
            </div>
            <Dialog open={moveOutOpen} onOpenChange={(open) => { setMoveOutOpen(open); setMoveOutError(null); }}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Move {drive.name} out of {org.name}?</DialogTitle>
                  <DialogDescription>Org members who reach it only because it is Open lose access unless you keep them as invited members.</DialogDescription>
                </DialogHeader>
                {moveOutError ? <p role="alert" className="text-sm text-destructive">{moveOutError}</p> : null}
                <DialogFooter className="gap-2">
                  <Button variant="outline" disabled={pending} onClick={() => void moveOut('remove')}>
                    Remove them
                  </Button>
                  <Button disabled={pending} onClick={() => void moveOut('keep')}>
                    Keep them as invited
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MoveInCard({ drive, organizations, onChanged }: { drive: Drive; organizations: MyOrganization[]; onChanged: () => void }) {
  const [orgId, setOrgId] = useState<string>(organizations[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const target = organizations.find((o) => o.id === orgId);
  const moveIn = async () => {
    if (!target) return;
    setPending(true);
    try {
      await put(`/api/drives/${drive.id}/org`, { orgId: target.id });
      toast.success(`${drive.name} moved into ${target.name}`);
      onChanged();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The drive could not be moved.'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Card data-testid="org-move-in-card">
      <CardHeader>
        <CardTitle>Organization</CardTitle>
        <CardDescription>
          {drive.name} belongs to you. Move it into an organization so the org pays for it and its rules apply. Members, roles, pages and publishing stay as they are; you stay its lead.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select value={orgId} onValueChange={setOrgId} disabled={pending}>
          <SelectTrigger className="w-full sm:w-64" aria-label="Organization"><SelectValue /></SelectTrigger>
          <SelectContent>
            {organizations.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" disabled={pending || !target} onClick={() => void moveIn()}>Move into organization</Button>
      </CardContent>
    </Card>
  );
}
