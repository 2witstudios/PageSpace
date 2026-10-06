'use client';

import useSWR from 'swr';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { guestChoice, inviteeStanding, seatChoice } from '@pagespace/lib/organizations/invite-choice';
import type { GuestPolicy } from '@pagespace/lib/organizations/policies-core';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';

export type JoinChoice = 'guest' | 'member';

interface OrgMemberRow {
  userId: string;
  email: string;
}

const membersFetcher = async (url: string): Promise<OrgMemberRow[]> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) return [];
  return ((await response.json()) as { members?: OrgMemberRow[] }).members ?? [];
};

/** The org's Guests policy, or null when the inviter may not read policies (Owner/Admin only). */
const policyFetcher = async (url: string): Promise<GuestPolicy | null> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) return null;
  return ((await response.json()) as { policies?: { guests?: GuestPolicy } }).policies?.guests ?? null;
};

/** The org drive context the invite page needs: the drive's org, its members and its Guests policy. */
export function useInviteOrgContext(orgId: string | null) {
  const on = ORGS_ENABLED && orgId !== null;
  const { data: members } = useSWR(on ? `/api/orgs/${orgId}/members` : null, membersFetcher, { revalidateOnFocus: false });
  const { data: guestPolicy } = useSWR(on ? `/api/orgs/${orgId}/policies` : null, policyFetcher, { revalidateOnFocus: false });
  return { enabled: on, members: members ?? [], guestPolicy: guestPolicy ?? null };
}

interface InviteJoinChoiceProps {
  inviteeName: string;
  invitee: { userId?: string | null; email?: string | null };
  driveName: string;
  orgName: string;
  members: OrgMemberRow[];
  guestPolicy: GuestPolicy | null;
  value: JoinChoice;
  onChange: (choice: JoinChoice) => void;
}

/**
 * "How should they join?" (Spec UI-5, DRV-8; canvas v9 InviteToDrive): shown for a person outside
 * the drive's organization. As a guest of this drive they hold no seat and see only this drive
 * (the Guests policy may hold it for an admin's approval); as a member of the org they take a seat.
 * Renders nothing for someone already in the org.
 */
export function InviteJoinChoice({ inviteeName, invitee, driveName, orgName, members, guestPolicy, value, onChange }: InviteJoinChoiceProps) {
  if (inviteeStanding(invitee, members) === 'in_org') {
    return <Badge variant="secondary" data-testid="invitee-in-org">In {orgName}</Badge>;
  }
  const guest = guestChoice({ driveName, orgName, guestPolicy });
  const seat = seatChoice({ orgName, hasEmail: Boolean(invitee.email) });
  const options = [
    { key: 'guest' as const, label: 'As a guest of this drive', ...guest },
    { key: 'member' as const, label: `As a member of ${orgName}`, ...seat },
  ];
  return (
    <Card className="mb-6" data-testid="invite-join-choice">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>How should {inviteeName} join?</CardTitle>
          <Badge variant="outline">Not in {orgName}</Badge>
        </div>
        <CardDescription>{driveName} belongs to {orgName}. Someone from outside can join just this drive, or the organization.</CardDescription>
      </CardHeader>
      <CardContent>
        <div role="radiogroup" aria-label="How they join" className="flex flex-col gap-2">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={value === o.key}
              disabled={!o.enabled}
              onClick={() => onChange(o.key)}
              className={cn(
                'flex flex-col gap-0.5 rounded-lg border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                value === o.key ? 'border-primary bg-primary/10' : 'hover:bg-accent',
              )}
            >
              <span className="text-sm font-medium">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.hint}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** The choice to start from: guest when allowed, else member when possible. */
export function defaultJoinChoice(input: { driveName: string; orgName: string; guestPolicy: GuestPolicy | null; hasEmail: boolean }): JoinChoice {
  return guestChoice(input).enabled || !seatChoice(input).enabled ? 'guest' : 'member';
}
