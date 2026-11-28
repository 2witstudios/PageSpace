'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSWRConfig } from 'swr';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useOrgAdminRead } from '@/hooks/useOrgs';
import { useDriveStore } from '@/hooks/useDrive';
import { OrgSettingsShell, type OrgSettingsContext } from '@/components/orgs/OrgSettingsShell';
import { del, post } from '@/lib/auth/auth-fetch';
import { isOrgKey, orgKeys, type OrgDriveDirectoryEntry, type OrgMember } from '@/lib/orgs/org-api';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';

const TRASH = '__trash__';

function DangerBody({ orgId, orgName, role, org }: OrgSettingsContext) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const fetchDrives = useDriveStore((s) => s.fetchDrives);
  const members = useOrgAdminRead<{ members: OrgMember[] }>(orgKeys.members(orgId), role).data?.members ?? [];
  const drives = useOrgAdminRead<{ drives: OrgDriveDirectoryEntry[] }>(orgKeys.drives(orgId), role).data?.drives ?? [];
  const others = members.filter((m) => m.userId !== org.viewer.userId);
  const [newOwner, setNewOwner] = useState('');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const transfer = async () => {
    setBusy(true);
    try {
      await post(`/api/orgs/${orgId}/transfer-ownership`, { toUserId: newOwner });
      toast.success('Ownership transferred. You are now an Admin.');
      void mutate((k) => isOrgKey(orgId, k) || k === orgKeys.mine());
      router.push(`/orgs/${orgId}/settings`);
    } catch (error) {
      toast.error(orgErrorMessage(error, 'Ownership could not be transferred.'));
    } finally {
      setBusy(false);
    }
  };

  const allChosen = drives.every((d) => choices[d.id]);
  const remove = async () => {
    setBusy(true);
    try {
      const body = drives.map((d) => (choices[d.id] === TRASH ? { driveId: d.id, action: 'trash' as const } : { driveId: d.id, action: 'transfer' as const, toUserId: choices[d.id] }));
      await del(`/api/orgs/${orgId}`, { drives: body });
      toast.success(`${orgName} was deleted`);
      void mutate(orgKeys.mine());
      void fetchDrives(false, true);
      router.push('/settings');
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The organization could not be deleted.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Transfer ownership</CardTitle>
          <CardDescription>The new Owner controls billing and can delete {orgName}. You become an Admin.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Select value={newOwner} onValueChange={setNewOwner}>
            <SelectTrigger aria-label="New owner" className="w-[220px]"><SelectValue placeholder="Choose a member…" /></SelectTrigger>
            <SelectContent>
              {others.map((m) => <SelectItem key={m.userId} value={m.userId}>{m.name || m.email}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" disabled={busy || !newOwner} onClick={() => void transfer()}>Transfer ownership</Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Delete {orgName}</CardTitle>
          <CardDescription>
            Its subscription ends and its members lose their seats. Choose what happens to each drive: hand it to a member as a personal drive, or move it to the trash. Nothing is left without an owner.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {drives.length > 0 ? (
            <div className="overflow-hidden rounded-lg border bg-card">
              {drives.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center gap-3 border-t px-4 py-2.5 first:border-t-0">
                  <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                  <Select value={choices[d.id] ?? ''} onValueChange={(v) => setChoices((c) => ({ ...c, [d.id]: v }))}>
                    <SelectTrigger aria-label={`What happens to ${d.name}`} className="h-8 w-[220px]"><SelectValue placeholder="Choose…" /></SelectTrigger>
                    <SelectContent>
                      {members.map((m) => <SelectItem key={m.userId} value={m.userId}>Give to {m.name || m.email}</SelectItem>)}
                      <SelectItem value={TRASH}>Move to trash</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="org-delete-confirm">Type {orgName} to confirm</Label>
            <Input id="org-delete-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="max-w-xs" />
          </div>
          <Button variant="destructive" disabled={busy || !allChosen || confirm !== orgName} onClick={() => void remove()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Delete organization
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function OrgDangerPage() {
  return (
    <OrgSettingsShell title="Danger Zone" minRole="OWNER" description={(orgName) => `Transfer ownership of ${orgName}, or delete it.`}>
      {(ctx) => <DangerBody {...ctx} />}
    </OrgSettingsShell>
  );
}
