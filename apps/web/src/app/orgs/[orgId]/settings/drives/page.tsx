'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { ArrowDownToLine, Folder, Lock, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDriveStore } from '@/hooks/useDrive';
import { useOrgAdminRead } from '@/hooks/useOrgs';
import { useEditingStore } from '@/stores/useEditingStore';
import { OrgBadge } from '@/components/orgs/OrgBadge';
import { OrgSettingsShell, PausedWhileUnpaid, type OrgSettingsContext } from '@/components/orgs/OrgSettingsShell';
import { isOrgKey, moveDriveIntoOrg, orgKeys, orgReadKeys, type OrgDriveDirectoryEntry, type OrgDriveUsage } from '@/lib/orgs/org-api';
import { post } from '@/lib/auth/auth-fetch';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { driveMembersLabel, movableDrives, VISIBILITY_COPY } from '@/lib/orgs/org-drives';
import { formatBytes } from '@/lib/utils/utils';
import { cn } from '@/lib/utils/index';

function MoveDriveInDialog({ orgId, orgName, open, onOpenChange, onMoved }: { orgId: string; orgName: string; open: boolean; onOpenChange: (o: boolean) => void; onMoved: () => void }) {
  const drives = useDriveStore((s) => s.drives);
  const fetchDrives = useDriveStore((s) => s.fetchDrives);
  const [selected, setSelected] = useState<string[]>([]);
  const [moving, setMoving] = useState(false);
  const candidates = movableDrives(drives);

  const move = async () => {
    setMoving(true);
    let moved = 0;
    for (const driveId of selected) {
      try {
        await moveDriveIntoOrg(driveId, orgId);
        moved += 1;
      } catch (error) {
        toast.error(orgErrorMessage(error, `${drives.find((d) => d.id === driveId)?.name ?? 'A drive'} could not be moved.`));
      }
    }
    setMoving(false);
    if (moved > 0) {
      toast.success(`${moved} ${moved === 1 ? 'drive' : 'drives'} moved into ${orgName}`);
      void fetchDrives(false, true);
      onMoved();
    }
    setSelected([]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Move drives into {orgName}</DialogTitle>
          <DialogDescription>They become org-owned: {orgName} pays for them and org policies apply. Members keep their roles, and you stay the drive lead.</DialogDescription>
        </DialogHeader>
        <div className="overflow-hidden rounded-lg border bg-card">
          {candidates.length === 0 ? (
            <div className="px-3.5 py-3 text-sm text-muted-foreground">You have no personal drives to move. Home always stays personal.</div>
          ) : (
            candidates.map((d, i) => (
              <label key={d.id} className={cn('flex cursor-pointer items-center gap-3 px-3.5 py-2.5', i > 0 && 'border-t')}>
                <Checkbox
                  checked={selected.includes(d.id)}
                  onCheckedChange={(c) => setSelected((prev) => (c === true ? [...prev, d.id] : prev.filter((id) => id !== d.id)))}
                  aria-label={`Move ${d.name}`}
                />
                <Folder className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">{d.name}</span>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={moving}>Cancel</Button>
          <Button onClick={() => void move()} disabled={moving || selected.length === 0}>
            {moving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Move in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewOrgDriveDialog({ orgId, orgName, open, onOpenChange, onCreated }: { orgId: string; orgName: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const fetchDrives = useDriveStore((s) => s.fetchDrives);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    useEditingStore.getState().startEditing('org-new-drive', 'form', { componentName: 'NewOrgDriveDialog' });
    return () => useEditingStore.getState().endEditing('org-new-drive');
  }, [open]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await post('/api/drives', { name: name.trim(), orgId });
      toast.success(`${name.trim()} created in ${orgName}`);
      void fetchDrives(false, true);
      onCreated();
      setName('');
      onOpenChange(false);
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The drive could not be created.'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={create} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New drive in {orgName}</DialogTitle>
            <DialogDescription>Owned and paid for by {orgName}, and Open to its members. You lead it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="org-new-drive-name">Name</Label>
            <Input id="org-new-drive-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>Cancel</Button>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create drive
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DrivesPageBody({ orgId, orgName, role, lapsed }: OrgSettingsContext) {
  const { mutate } = useSWRConfig();
  const directory = useOrgAdminRead<{ drives: OrgDriveDirectoryEntry[] }>(orgKeys.drives(orgId), role).data?.drives;
  const usage = useOrgAdminRead<{ usage: OrgDriveUsage[] }>(orgReadKeys.driveUsage(orgId), role).data?.usage;
  const allDrives = useDriveStore((s) => s.drives);
  const fetchDrives = useDriveStore((s) => s.fetchDrives);
  const [tab, setTab] = useState<'org' | 'trashed'>('org');
  const [moving, setMoving] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void fetchDrives(true);
  }, [fetchDrives]);

  const refresh = () => void mutate((key) => isOrgKey(orgId, key));
  const usageById = new Map((usage ?? []).map((u) => [u.driveId, u]));
  const trashed = allDrives.filter((d) => d.orgId === orgId && d.isTrashed);

  return (
    <>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="tablist" className="inline-flex w-fit gap-1 rounded-lg bg-muted p-[3px]">
          {([['org', 'Org drives', directory?.length ?? 0], ['trashed', 'Trashed', trashed.length]] as const).map(([id, label, n]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium', tab === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}
            >
              {label} <span className="text-xs text-muted-foreground">{n}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
            <ArrowDownToLine className="mr-1.5 h-4 w-4" />
            Move a drive in
          </Button>
          <Button size="sm" onClick={() => setCreating(true)} disabled={lapsed}>
            <Plus className="mr-1.5 h-4 w-4" />
            New drive
          </Button>
        </div>
      </div>
      {lapsed ? <div className="mb-3"><PausedWhileUnpaid>Creating org drives is paused while unpaid.</PausedWhileUnpaid></div> : null}

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="hidden items-center gap-4 bg-muted px-4 py-2 text-xs text-muted-foreground md:flex">
          <span className="w-5" />
          <span className="flex-1">Drive</span>
          <span className="w-[82px] text-center">Visibility</span>
          <span className="w-[90px]">Members</span>
          <span className="w-[70px]">Storage</span>
          <span className="w-[76px]" />
        </div>
        {tab === 'org'
          ? (directory ?? []).map((d) => {
              const copy = VISIBILITY_COPY[d.orgVisibility];
              const u = usageById.get(d.id);
              return (
                <div key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-3.5 first:border-t-0 md:flex-nowrap">
                  {d.orgVisibility === 'PRIVATE' ? <Lock className="h-5 w-5 text-muted-foreground" /> : <Folder className="h-5 w-5 text-muted-foreground" />}
                  <div className="flex min-w-0 flex-1 basis-[calc(100%-2.5rem)] flex-col gap-0.5 md:basis-0">
                    <span className="truncate font-medium">{d.name}</span>
                    <span className="truncate text-[13px] text-muted-foreground">Lead: {d.lead.name ?? 'Unknown'}</span>
                  </div>
                  <OrgBadge tone={copy.tone} className="w-[82px] justify-center">{copy.label}</OrgBadge>
                  <span className="text-xs tabular-nums text-muted-foreground md:w-[90px]">{driveMembersLabel(u)}</span>
                  <span className="text-xs tabular-nums text-muted-foreground md:w-[70px]">{u ? formatBytes(u.storageBytes, 1) : ''}</span>
                  <Button variant="ghost" size="sm" asChild className="ml-auto md:ml-0 md:w-[76px]">
                    <Link href={`/dashboard/${d.id}/settings`}>Settings</Link>
                  </Button>
                </div>
              );
            })
          : trashed.map((d) => (
              <div key={d.id} className="flex items-center gap-4 border-t px-4 py-3.5 first:border-t-0">
                <Folder className="h-5 w-5 text-muted-foreground" />
                <span className="flex-1 truncate font-medium">{d.name}</span>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/dashboard/trash">Open trash</Link>
                </Button>
              </div>
            ))}
        {(tab === 'org' ? directory?.length ?? 0 : trashed.length) === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">{tab === 'org' ? `${orgName} owns no drives yet.` : 'Nothing in the trash.'}</div>
        ) : null}
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>What visibility means</CardTitle>
          <CardDescription>Set per drive by its lead or an org admin. It only affects people already in {orgName}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(Object.keys(VISIBILITY_COPY) as Array<keyof typeof VISIBILITY_COPY>).map((v) => (
            <div key={v} className="flex items-start gap-3">
              <OrgBadge tone={VISIBILITY_COPY[v].tone} className="w-[82px] justify-center">{VISIBILITY_COPY[v].label}</OrgBadge>
              <span className="text-[13px] leading-[18px] text-muted-foreground">{VISIBILITY_COPY[v].description}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <MoveDriveInDialog orgId={orgId} orgName={orgName} open={moving} onOpenChange={setMoving} onMoved={refresh} />
      <NewOrgDriveDialog orgId={orgId} orgName={orgName} open={creating} onOpenChange={setCreating} onCreated={refresh} />
    </>
  );
}

export default function OrgDrivesPage() {
  return (
    <OrgSettingsShell
      title="Drives"
      description={(orgName) => `Drives owned by ${orgName}. Org policies apply to all of them, and org admins can manage any of them.`}
    >
      {(ctx) => <DrivesPageBody {...ctx} />}
    </OrgSettingsShell>
  );
}
