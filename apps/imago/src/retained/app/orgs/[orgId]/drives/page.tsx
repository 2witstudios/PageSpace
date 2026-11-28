'use client';

import Link from '@/retained-adapters/link';
import { useEffect, useState } from 'react';
import { useParams } from '@/retained-adapters/navigation';
import { Folder, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/retained/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/retained/components/ui/dialog';
import { Label } from '@/retained/components/ui/label';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Textarea } from '@/retained/components/ui/textarea';
import { OrgBadge } from '@/retained/components/orgs/OrgBadge';
import { OrgPageContainer, OrgPageHeader } from '@/retained/components/orgs/OrgPageHeader';
import { useOrg, useOrgDriveDirectory, useOrgRealtime } from '@/retained/hooks/useOrgs';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { requestToJoinDrive, type OrgDriveDirectoryEntry } from '@/retained/lib/orgs/org-api';
import { orgErrorMessage } from '@/retained/lib/orgs/org-error-copy';
import { directoryAction, directorySections, VISIBILITY_COPY, type DirectorySection } from '@/retained/lib/orgs/org-drives';

const SECTION_COPY: Record<DirectorySection['kind'], { title: string; description: (orgName: string) => string }> = {
  mine: { title: 'Your drives', description: () => 'Open drives, and drives you have joined.' },
  restricted: { title: 'Ask to join', description: () => 'Restricted drives. Their lead or an org admin approves a request; until then the drive stays closed.' },
  admin: { title: 'Private drives', description: (orgName) => `Invite only. Listed to you because you administer ${orgName}.` },
};

/** Join request dialog: an optional note to the drive lead. */
function RequestToJoinDialog({ drive, onOpenChange, onRequested }: { drive: OrgDriveDirectoryEntry | null; onOpenChange: (open: boolean) => void; onRequested: () => void }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const open = drive !== null;

  useEffect(() => {
    if (!open) return;
    useEditingStore.getState().startEditing('org-join-request', 'form', { componentName: 'RequestToJoinDialog' });
    return () => useEditingStore.getState().endEditing('org-join-request');
  }, [open]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!drive) return;
    setSending(true);
    try {
      await requestToJoinDrive(drive.id, message.trim() || undefined);
      toast.success(`Request sent to ${drive.lead.name ?? 'the drive lead'}`);
      setMessage('');
      onRequested();
      onOpenChange(false);
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The request could not be sent.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={send} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Ask to join {drive?.name}</DialogTitle>
            <DialogDescription>
              {drive?.lead.name ?? 'The drive lead'} or an org admin approves. You get access only once they do.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="join-request-message">Note (optional)</Label>
            <Textarea id="join-request-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} rows={3} placeholder="What you need it for" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>Cancel</Button>
            <Button type="submit" disabled={sending}>
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Send request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DirectoryRowAction({ drive, onAsk }: { drive: OrgDriveDirectoryEntry; onAsk: (drive: OrgDriveDirectoryEntry) => void }) {
  switch (directoryAction(drive)) {
    case 'open':
      return (
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/dashboard/${drive.id}`}>Open</Link>
        </Button>
      );
    case 'request':
      return <Button variant="outline" size="sm" onClick={() => onAsk(drive)}>Ask to join</Button>;
    case 'requested':
      return <OrgBadge tone="pending">Requested</OrgBadge>;
    case 'invited':
      return <span className="text-xs text-muted-foreground">Invitation waiting in your notifications</span>;
    case 'manage':
      return (
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/dashboard/${drive.id}/settings`}>Manage</Link>
        </Button>
      );
  }
}

function DirectoryList({ orgName, drives, onAsk }: { orgName: string; drives: OrgDriveDirectoryEntry[]; onAsk: (drive: OrgDriveDirectoryEntry) => void }) {
  const sections = directorySections(drives);
  if (sections.length === 0) {
    return <div className="rounded-lg border bg-card px-4 py-6 text-center text-sm text-muted-foreground">{orgName} has no drives you can see yet.</div>;
  }
  return (
    <div className="space-y-8">
      {sections.map((section) => (
        <section key={section.kind} aria-labelledby={`directory-${section.kind}`}>
          <h2 id={`directory-${section.kind}`} className="px-1 text-sm font-medium text-muted-foreground">{SECTION_COPY[section.kind].title}</h2>
          <p className="mb-2 px-1 text-xs text-muted-foreground">{SECTION_COPY[section.kind].description(orgName)}</p>
          <ul className="overflow-hidden rounded-lg border bg-card">
            {section.drives.map((d) => (
              <li key={d.id} className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0">
                {d.orgVisibility === 'PRIVATE' ? <Lock className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <Folder className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">{d.name}</span>
                  <span className="truncate text-[13px] text-muted-foreground">Lead: {d.lead.name ?? 'Unknown'}</span>
                </div>
                <OrgBadge tone={VISIBILITY_COPY[d.orgVisibility].tone} className="hidden sm:inline-flex">{VISIBILITY_COPY[d.orgVisibility].label}</OrgBadge>
                <DirectoryRowAction drive={d} onAsk={onAsk} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * /orgs/[orgId]/drives — the org Drives directory (DRV-6, D-OW-25) for every member, Members
 * included: it is not an org setting (UI-11), it is the only place a Restricted drive is found
 * before joining. Open drives and drives I joined open from here; a Restricted drive is asked
 * for; a Private drive is listed only to people who can already open it, and to org admins.
 */
export default function OrgDrivesDirectoryPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const { org, isLoading, error } = useOrg(orgId);
  const directory = useOrgDriveDirectory(org ? orgId : undefined);
  const [asking, setAsking] = useState<OrgDriveDirectoryEntry | null>(null);
  useOrgRealtime(orgId);

  if (isLoading) {
    return (
      <OrgPageContainer>
        <Skeleton className="mb-2 h-8 w-48" />
        <Skeleton className="mb-8 h-4 w-80" />
        <Skeleton className="h-64 w-full" />
      </OrgPageContainer>
    );
  }
  if (!org) {
    return (
      <OrgPageContainer>
        <OrgPageHeader backHref="/dashboard" backLabel="Back to Dashboard" title="Drives" />
        <p className="text-muted-foreground">{orgErrorMessage(error, 'This organization could not be loaded.')}</p>
      </OrgPageContainer>
    );
  }
  const orgName = org.organization.name;
  return (
    <OrgPageContainer>
      <OrgPageHeader backHref={`/orgs/${orgId}/settings`} backLabel={`Back to ${orgName}`} title="Drives" description={`Drives in ${orgName} you can open or ask to join.`} />
      {directory.data ? (
        <DirectoryList orgName={orgName} drives={directory.data.drives} onAsk={setAsking} />
      ) : directory.error ? (
        <p className="text-muted-foreground">{orgErrorMessage(directory.error, 'The drives could not be loaded.')}</p>
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
      <RequestToJoinDialog drive={asking} onOpenChange={(open) => !open && setAsking(null)} onRequested={() => void directory.mutate()} />
    </OrgPageContainer>
  );
}
