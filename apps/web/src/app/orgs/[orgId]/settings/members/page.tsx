'use client';

import { useMemo, useState } from 'react';
import { useSWRConfig } from 'swr';
import { formatDistanceToNowStrict } from 'date-fns';
import { Mail, MoreHorizontal, Search, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import { useOrgAdminRead, useOrgSeats } from '@/hooks/useOrgs';
import { OrgBadge, OrgRoleBadge } from '@/components/orgs/OrgBadge';
import { OrgSettingsShell, PausedWhileUnpaid, type OrgSettingsContext } from '@/components/orgs/OrgSettingsShell';
import { InviteMembersDialog } from '@/components/orgs/InviteMembersDialog';
import { SeatCapsCard } from '@/components/orgs/SeatCapsCard';
import {
  changeOrgMemberRole,
  inviteToOrg,
  isOrgKey,
  orgKeys,
  orgReadKeys,
  removeOrgMember,
  resendOrgInvitation,
  revokeOrgInvitation,
  type OrgGuest,
  type OrgInvitation,
  type OrgMember,
  type OrgMemberActivity,
  type OrgSeatCapsRead,
} from '@/lib/orgs/org-api';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { filterMembers, inviteStatusLine, liveInvitations, memberTabCounts, seatCapsLabel, type MemberTab } from '@/lib/orgs/org-members';
import { cn } from '@/lib/utils/index';

const initials = (name: string | null, email: string | null) =>
  (name || email || '?').split(/[\s@]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');

function lastActiveLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  if (Date.now() - ms < 5 * 60_000) return 'Now';
  return `${formatDistanceToNowStrict(ms)} ago`;
}

function Stat({ value, suffix, label }: { value: string; suffix?: string; label: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-background p-4">
      <span className="text-2xl font-semibold tabular-nums tracking-tight">
        {value}
        {suffix ? <span className="text-sm font-medium text-muted-foreground"> {suffix}</span> : null}
      </span>
      <span className="text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}

function MembersPageBody({ orgId, orgName, role, lapsed }: OrgSettingsContext) {
  const { mutate } = useSWRConfig();
  const { showBilling } = useBillingVisibility();
  const members = useOrgAdminRead<{ members: OrgMember[] }>(orgKeys.members(orgId), role).data?.members;
  const invitations = useOrgAdminRead<{ invitations: OrgInvitation[] }>(orgKeys.invitations(orgId), role).data?.invitations;
  const guests = useOrgAdminRead<{ guests: OrgGuest[] }>(orgKeys.guests(orgId), role).data?.guests;
  const activity = useOrgAdminRead<{ activity: OrgMemberActivity[] }>(orgReadKeys.memberActivity(orgId), role).data?.activity;
  const seatCaps = useOrgAdminRead<OrgSeatCapsRead>(orgReadKeys.seatCaps(orgId), role).data;
  const seats = useOrgSeats(orgId, role, showBilling).data?.seats;

  const [tab, setTab] = useState<MemberTab>('all');
  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState(false);
  const [capsFor, setCapsFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OrgMember | null>(null);

  const refresh = () => void mutate((key) => isOrgKey(orgId, key));
  const now = Date.now();
  const pending = useMemo(() => liveInvitations(invitations ?? [], now), [invitations, now]);
  // SEAT-3: the server's count of seat-reserving invitations (one source); the list is only for the rows.
  const pendingCount = seats?.pendingInvites ?? pending.length;
  const counts = memberTabCounts({ members: members ?? [], pending: pendingCount, guests: guests?.length ?? 0 });
  const shown = filterMembers(members ?? [], tab, query);
  const activityById = new Map((activity ?? []).map((a) => [a.userId, a]));
  const capsById = new Map((seatCaps?.seats ?? []).map((s) => [s.userId, s]));
  const nameById = new Map((members ?? []).map((m) => [m.userId, m.name || m.email]));
  const canChangeRoles = orgRoleAtLeast(role, 'ADMIN');
  const capsMember = capsFor ? (members ?? []).find((m) => m.userId === capsFor) : undefined;

  const act = async (fn: () => Promise<unknown>, success: string, fallback: string) => {
    try {
      await fn();
      toast.success(success);
      refresh();
    } catch (error) {
      toast.error(orgErrorMessage(error, fallback));
    }
  };

  const tabs: { id: MemberTab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'admins', label: 'Admins' },
    { id: 'pending', label: 'Pending' },
    { id: 'guests', label: 'Guests' },
  ];

  return (
    <>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          value={String(seats?.members ?? members?.length ?? 0)}
          suffix={showBilling && seats ? `of ${seats.purchased} seats` : 'members'}
          label={`Seats in use · ${pendingCount} reserved by pending invites`}
        />
        <Stat value={String(guests?.length ?? 0)} label="Guests · no seat, limited to the drives they were invited to" />
        <Stat value={String(counts.admins)} label="Admins · can manage every org drive and these settings" />
      </div>

      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="tablist" className="inline-flex w-fit gap-1 rounded-lg bg-muted p-[3px]">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium',
                tab === t.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground',
              )}
            >
              {t.label} <span className="text-xs text-muted-foreground">{counts[t.id]}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-60">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <Input aria-label="Search members" placeholder="Search members…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 pl-8" />
          </div>
          <Button size="sm" onClick={() => setInviting(true)} disabled={lapsed}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            Invite people
          </Button>
        </div>
      </div>
      {lapsed ? <div className="mb-3"><PausedWhileUnpaid>Inviting is paused while unpaid. Removing members and revoking invitations still work.</PausedWhileUnpaid></div> : null}

      {tab !== 'guests' ? (
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="hidden items-center gap-4 bg-muted px-4 py-2 text-xs text-muted-foreground md:flex">
            <span className="w-8" />
            <span className="flex-1">Member</span>
            <span className="w-[84px]">Drives</span>
            <span className="w-24">Last active</span>
            <span className="w-[120px]">Seat caps</span>
            <span className="w-28">Org role</span>
            <span className="w-9" />
          </div>
          {tab !== 'pending'
            ? shown.map((m) => {
                const a = activityById.get(m.userId);
                const caps = capsById.get(m.userId);
                return (
                  <div key={m.userId} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-3.5 first:border-t-0 md:flex-nowrap">
                    <Avatar className="h-8 w-8">
                      {m.image ? <AvatarImage src={m.image} alt="" /> : null}
                      <AvatarFallback className="text-xs">{initials(m.name, m.email)}</AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-1 basis-[calc(100%-3rem)] flex-col gap-0.5 md:basis-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{m.name || m.email}</span>
                        <OrgRoleBadge role={m.role} />
                      </div>
                      <span className="truncate text-[13px] text-muted-foreground">{m.email}</span>
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground md:w-[84px]">{a ? `${a.driveCount} ${a.driveCount === 1 ? 'drive' : 'drives'}` : ''}</span>
                    <span className="text-xs tabular-nums text-muted-foreground md:w-24">{lastActiveLabel(a?.lastActiveAt)}</span>
                    <span className="text-xs tabular-nums text-muted-foreground md:w-[120px]">{caps ? seatCapsLabel(caps) : ''}</span>
                    <span className="md:w-28">
                      {m.role === 'OWNER' || !canChangeRoles ? (
                        <span className="text-xs text-muted-foreground">{m.role === 'OWNER' ? 'Owner' : m.role === 'ADMIN' ? 'Admin' : 'Member'}</span>
                      ) : (
                        <Select
                          value={m.role}
                          onValueChange={(next) =>
                            void act(() => changeOrgMemberRole(orgId, m.userId, next as 'ADMIN' | 'MEMBER'), `${m.name || m.email} is now ${next === 'ADMIN' ? 'an Admin' : 'a Member'}`, 'The role could not be changed.')
                          }
                        >
                          <SelectTrigger aria-label={`Org role for ${m.name || m.email}`} className="h-8 w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ADMIN">Admin</SelectItem>
                            <SelectItem value="MEMBER">Member</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={`Actions for ${m.name || m.email}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setCapsFor(m.userId)}>Seat caps</DropdownMenuItem>
                        {m.role !== 'OWNER' ? (
                          <DropdownMenuItem className="text-destructive" onSelect={() => setRemoving(m)}>
                            Remove from {orgName}
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              })
            : null}
          {tab === 'all' || tab === 'pending'
            ? pending.map((inv) => (
                <div key={inv.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-background px-4 py-3.5 first:border-t-0">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-dashed">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                  </span>
                  <div className="flex min-w-0 flex-1 basis-[calc(100%-3rem)] flex-col gap-0.5 md:basis-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{inv.email}</span>
                      <OrgBadge tone="pending">Invited</OrgBadge>
                    </div>
                    <span className="truncate text-[13px] text-muted-foreground">{inviteStatusLine(inv, inv.invitedBy ? (nameById.get(inv.invitedBy) ?? null) : null, now)}</span>
                  </div>
                  <Button variant="ghost" size="sm" disabled={lapsed} onClick={() => void act(() => resendOrgInvitation(orgId, inv.id), `Invitation resent to ${inv.email}`, 'The invitation could not be resent.')}>
                    Resend
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void act(() => revokeOrgInvitation(orgId, inv.id), `Invitation to ${inv.email} revoked`, 'The invitation could not be revoked.')}>
                    Revoke
                  </Button>
                </div>
              ))
            : null}
          {(tab === 'pending' && pending.length === 0) || (tab !== 'pending' && shown.length === 0 && (tab !== 'all' || pending.length === 0)) ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">Nobody here yet.</div>
          ) : null}
        </div>
      ) : null}

      {capsMember && seatCaps?.walletId ? (
        <SeatCapsCard
          orgId={orgId}
          member={capsMember}
          seat={capsById.get(capsMember.userId)}
          seatAllowanceCents={seatCaps.seatAllowanceCents}
          lapsed={lapsed}
          onClose={() => setCapsFor(null)}
          onSaved={refresh}
        />
      ) : capsMember ? (
        <p className="mt-6 text-sm text-muted-foreground">Seat caps apply once {orgName} has a credits pool, after its first payment.</p>
      ) : null}

      {tab === 'all' || tab === 'guests' ? (
        <section className="mt-8">
          <div className="mb-3 flex flex-col">
            <h2 className="text-lg font-semibold">Guests ({guests?.length ?? 0})</h2>
            <p className="text-xs text-muted-foreground">
              People outside {orgName} who were invited to a drive. Allowed by the <a className="text-primary hover:underline" href={`/orgs/${orgId}/settings/policies`}>Guests policy</a>.
            </p>
          </div>
          <div className="overflow-hidden rounded-lg border bg-card">
            {(guests ?? []).length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">No guests.</div>
            ) : (
              (guests ?? []).map((g) => (
                <div key={g.userId} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-3.5 first:border-t-0">
                  <Avatar className="h-8 w-8">
                    {g.image ? <AvatarImage src={g.image} alt="" /> : null}
                    <AvatarFallback className="text-xs">{initials(g.name, g.email)}</AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-1 basis-[calc(100%-3rem)] flex-col gap-0.5 md:basis-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{g.name || g.email}</span>
                      <OrgBadge tone="guest">Guest</OrgBadge>
                    </div>
                    <span className="truncate text-[13px] text-muted-foreground">
                      {[g.email, `in ${g.drives.map((d) => (d.pending ? `${d.name} (invited)` : d.name)).join(', ')}`].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={lapsed || !g.email}
                    onClick={() =>
                      g.email &&
                      void act(() => inviteToOrg(orgId, { email: g.email as string }), `Invitation sent. ${g.name || g.email} gets a seat when they accept.`, 'The seat could not be offered.')
                    }
                  >
                    Give a seat
                  </Button>
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}

      <InviteMembersDialog orgId={orgId} orgName={orgName} open={inviting} onOpenChange={setInviting} onInvited={refresh} />

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name || removing?.email} from {orgName}?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose the access their membership gave them and free their seat at the end of the billing period. Drives they lead are handed to another member.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target) void act(() => removeOrgMember(orgId, target.userId), `${target.name || target.email} was removed`, 'The member could not be removed.');
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function OrgMembersPage() {
  return (
    <OrgSettingsShell
      title="Members & seats"
      description={(orgName) => `People in ${orgName}. Every member uses a seat and can be added to any org drive.`}
    >
      {(ctx) => <MembersPageBody {...ctx} />}
    </OrgSettingsShell>
  );
}
