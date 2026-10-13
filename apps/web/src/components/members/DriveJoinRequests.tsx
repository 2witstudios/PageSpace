'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMyOrganizations } from '@/hooks/useMyOrganizations';
import { useOrgLapsed, LAPSED_LOOSEN_NOTE } from '@/hooks/useOrgLapsed';
import type { Drive } from '@/hooks/useDrive';
import { answerDriveJoinRequest, driveJoinRequestsKey, orgFetcher, type DriveJoinRequestView } from '@/lib/orgs/org-api';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { mayAnswerJoinRequests } from '@/lib/orgs/org-drives';

/**
 * Join requests on a Restricted org drive (DRV-6), for whoever answers them: the drive lead and
 * the org Owner and Admins. Nothing renders, and nothing is fetched, for anyone else. Approving
 * admits the person through the org membership sync (their sidebar updates live); while the org is
 * unpaid approving is paused and declining still works (D-OW-33).
 */
export function DriveJoinRequests({ drive }: { drive: Drive }) {
  const { orgById } = useMyOrganizations();
  const lapsed = useOrgLapsed(drive.orgId);
  const answers = ORGS_ENABLED && mayAnswerJoinRequests(drive, orgById(drive.orgId)?.role);
  const { data, mutate } = useSWR<{ requests: DriveJoinRequestView[] }>(answers ? driveJoinRequestsKey(drive.id) : null, orgFetcher, { revalidateOnFocus: true });
  const [busy, setBusy] = useState<string | null>(null);

  const requests = data?.requests ?? [];
  if (!answers || requests.length === 0) return null;

  const answer = async (request: DriveJoinRequestView, decision: 'approve' | 'deny') => {
    setBusy(request.id);
    const who = request.name ?? request.email;
    try {
      await answerDriveJoinRequest(drive.id, request.id, decision);
      toast.success(decision === 'approve' ? `${who} joined ${drive.name}` : `Declined ${who}'s request`);
      void mutate();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The request could not be answered.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Join requests</CardTitle>
        <CardDescription>
          People in the organization asking to join {drive.name}. Approving makes them a member with the drive&rsquo;s default role.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {lapsed ? <p className="text-xs text-muted-foreground">{LAPSED_LOOSEN_NOTE}</p> : null}
        <ul className="divide-y rounded-lg border">
          {requests.map((r) => {
            const who = r.name ?? r.email;
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
                <Avatar className="h-8 w-8">
                  {r.image ? <AvatarImage src={r.image} alt="" /> : null}
                  <AvatarFallback>{who.slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{who}</span>
                  {r.message ? <span className="line-clamp-2 text-xs text-muted-foreground">&ldquo;{r.message}&rdquo;</span> : <span className="truncate text-xs text-muted-foreground">{r.email}</span>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => void answer(r, 'deny')} disabled={busy !== null} aria-label={`Decline ${who}`}>
                    Decline
                  </Button>
                  <Button size="sm" onClick={() => void answer(r, 'approve')} disabled={busy !== null || lapsed} aria-label={`Approve ${who}`}>
                    Approve
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
