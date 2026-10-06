'use client';

import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { Bot, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import type { OrgPolicies } from '@pagespace/lib/organizations/policies-core';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useOrgAdminRead } from '@/hooks/useOrgs';
import { OrgBadge } from '@/components/orgs/OrgBadge';
import { OrgSettingsShell, PausedWhileUnpaid, type OrgSettingsContext } from '@/components/orgs/OrgSettingsShell';
import {
  decideGuestApproval,
  deleteAutomation,
  isOrgKey,
  orgKeys,
  orgReadKeys,
  reassignAutomation,
  type GuestApproval,
  type OrgDriveDirectoryEntry,
  type OrgMember,
  type OwnerLeftAutomation,
} from '@/lib/orgs/org-api';
import { guestRequestCopy } from '@/lib/orgs/org-attention';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';

const GUEST_POLICY_WORDS: Record<OrgPolicies['guests'], string> = { on: 'On', approve: 'Admins approve', off: 'Off' };
const KIND_WORDS: Record<OwnerLeftAutomation['kind'], string> = { workflow: 'Workflow', page_webhook: 'Page webhook' };
const initials = (name: string) => name.split(/[\s@]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');

function AutomationRow({ orgId, automation, driveName, members, onDone }: { orgId: string; automation: OwnerLeftAutomation; driveName: string; members: OrgMember[]; onDone: () => void }) {
  const [owner, setOwner] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, success: string, fallback: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      onDone();
    } catch (error) {
      toast.error(orgErrorMessage(error, fallback));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 border-t px-4 py-3.5 first:border-t-0 md:flex-row md:items-start">
      <Bot className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{automation.name}</span>
          <OrgBadge tone="restricted">Owner left</OrgBadge>
          <OrgBadge tone="pending">Disabled</OrgBadge>
        </div>
        <span className="text-[13px] text-muted-foreground">
          {KIND_WORDS[automation.kind]} in <b>{driveName}</b> · its creator is no longer in the organization
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={owner} onValueChange={setOwner}>
          <SelectTrigger aria-label={`New owner for ${automation.name}`} className="h-8 w-[168px]"><SelectValue placeholder="Reassign to…" /></SelectTrigger>
          <SelectContent>
            {members.map((m) => <SelectItem key={m.userId} value={m.userId}>{m.name || m.email}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={busy || !owner} onClick={() => void act(() => reassignAutomation(orgId, automation, owner), `${automation.name} now runs as its new owner`, 'The automation could not be reassigned.')}>
          Reassign
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void act(() => deleteAutomation(orgId, automation), `${automation.name} deleted`, 'The automation could not be deleted.')}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function AttentionBody({ orgId, role, lapsed }: OrgSettingsContext) {
  const { mutate } = useSWRConfig();
  const approvals = useOrgAdminRead<{ total: number; items: GuestApproval[] }>(orgKeys.guestApprovals(orgId), role).data;
  const automations = useOrgAdminRead<{ automations: OwnerLeftAutomation[] }>(orgKeys.automations(orgId), role).data?.automations;
  const members = useOrgAdminRead<{ members: OrgMember[] }>(orgKeys.members(orgId), role).data?.members ?? [];
  const policies = useOrgAdminRead<{ policies: OrgPolicies }>(orgReadKeys.policies(orgId), role).data?.policies;
  const drives = useOrgAdminRead<{ drives: OrgDriveDirectoryEntry[] }>(orgKeys.drives(orgId), role).data?.drives;
  const [deciding, setDeciding] = useState<string | null>(null);
  const refresh = () => void mutate((k) => isOrgKey(orgId, k));
  const driveName = new Map((drives ?? []).map((d) => [d.id, d.name]));

  const decide = async (item: GuestApproval, decision: 'approve' | 'decline') => {
    setDeciding(item.holdId);
    try {
      await decideGuestApproval(orgId, item.holdId, decision);
      toast.success(decision === 'approve' ? `${guestRequestCopy(item).who} was let in` : `The request from ${guestRequestCopy(item).who} was declined`);
      refresh();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The request could not be decided.'));
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="space-y-8">
      <section id="guests">
        <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">Guest approvals · {approvals?.total ?? 0} waiting</h2>
        <div className="overflow-hidden rounded-lg border bg-card">
          {(approvals?.items ?? []).length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">No guest requests are waiting.</div>
          ) : (
            (approvals?.items ?? []).map((item) => {
              const copy = guestRequestCopy(item);
              return (
                <div key={item.holdId} className="flex flex-col gap-3 border-t px-4 py-3.5 first:border-t-0 md:flex-row md:items-start">
                  <Avatar className="h-8 w-8"><AvatarFallback className="text-xs">{initials(copy.who)}</AvatarFallback></Avatar>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{copy.who}</span>
                      <OrgBadge tone="guest">Guest</OrgBadge>
                      {copy.viaLink ? <OrgBadge tone="outline"><Link2 className="h-3 w-3" />via link</OrgBadge> : null}
                    </div>
                    <span className="text-[13px] text-muted-foreground">{copy.wants} <b>{item.driveName}</b></span>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      {copy.facts.map((f) => <span key={f}>{f}</span>)}
                    </div>
                    {lapsed ? <PausedWhileUnpaid>Reactivate the organization to approve guests.</PausedWhileUnpaid> : null}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={deciding !== null} onClick={() => void decide(item, 'decline')}>Decline</Button>
                    <Button size="sm" disabled={deciding !== null || lapsed} onClick={() => void decide(item, 'approve')}>Approve</Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          {policies ? <>The Guests policy is <b>{GUEST_POLICY_WORDS[policies.guests]}</b>. </> : null}
          Approving grants exactly the access shown. Declining drops the request; nothing was granted while it waited.
        </p>
      </section>

      <section id="automations">
        <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">Automations whose owner left</h2>
        <div className="overflow-hidden rounded-lg border bg-card">
          {(automations ?? []).length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">Every automation has an owner.</div>
          ) : (
            (automations ?? []).map((a) => (
              <AutomationRow key={`${a.kind}:${a.id}`} orgId={orgId} automation={a} driveName={driveName.get(a.driveId) ?? 'a drive'} members={members} onDone={refresh} />
            ))
          )}
        </div>
        <p className="mt-2 px-1 text-xs text-muted-foreground">Nothing runs under a missing person. Once reassigned, the automation spends the drive's wallet only, under its new owner's caps.</p>
      </section>
    </div>
  );
}

export default function OrgAttentionPage() {
  return (
    <OrgSettingsShell title="Needs your attention" description={(orgName) => `Requests and automations that wait for the Owner or an Admin of ${orgName}.`}>
      {(ctx) => <AttentionBody {...ctx} />}
    </OrgSettingsShell>
  );
}
