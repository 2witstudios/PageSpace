'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { KeyRound, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchJSON } from '@/lib/auth/auth-fetch';
import {
  describeOrgSignInRequirement,
  strongestRequirement,
  type OrgSignInDenialCode,
} from '@/lib/auth/org-sign-in-denial';
import { completeEmailedReauthentication, reauthenticateCurrentSession } from '@/lib/auth/session-reauthentication';
import { useOrgReauthStore } from '@/stores/useOrgReauthStore';
import { useDriveStore } from '@/hooks/useDrive';

export interface LockedDrive {
  driveId: string;
  driveName: string;
  orgId: string;
  orgName: string | null;
  code: OrgSignInDenialCode;
}

/** One line per org that asked, strongest requirement first. */
export function orgRequirements(
  denials: ReadonlyArray<{ code: OrgSignInDenialCode; orgId: string | null }>,
  locked: readonly LockedDrive[],
): Array<{ key: string; code: OrgSignInDenialCode; orgName: string | null }> {
  const byOrg = new Map<string, { code: OrgSignInDenialCode; orgName: string | null }>();
  const add = (key: string, code: OrgSignInDenialCode, orgName: string | null) => {
    const prior = byOrg.get(key);
    byOrg.set(key, { code: strongestRequirement(prior ? [prior.code, code] : [code]) ?? code, orgName: prior?.orgName ?? orgName });
  };
  for (const l of locked) add(l.orgId, l.code, l.orgName);
  for (const d of denials) if (d.orgId) add(d.orgId, d.code, null);
  // A denial that named no org still has to be explained when nothing else is known.
  for (const d of denials) if (!d.orgId && (byOrg.size === 0 || byOrg.has('unknown'))) add('unknown', d.code, null);
  return [...byOrg.entries()].map(([key, v]) => ({ key, ...v }));
}

/**
 * D-OW-45: the one re-authentication prompt. It opens when the shared fetch layer reports that an org's sign-in policy
 * refused this session, says which org requires what, and re-runs the ceremony for THIS session: a passkey for strong
 * sign-in; the person's passkey or an emailed link for a sign-in that is too old. Nothing signs them out. It also
 * finishes an emailed confirmation link that landed back in the app.
 */
export function OrgReauthenticationPrompt() {
  const denials = useOrgReauthStore((s) => s.denials);
  const dismiss = useOrgReauthStore((s) => s.dismiss);
  const { mutate } = useSWRConfig();
  const fetchDrives = useDriveStore((s) => s.fetchDrives);
  const open = denials.length > 0;
  const { data, mutate: refreshLocked } = useSWR<{ locked: LockedDrive[] }>(open ? '/api/drives/locked' : null, (url: string) => fetchJSON<{ locked: LockedDrive[] }>(url));
  const [busy, setBusy] = useState(false);
  const [awaitingEmail, setAwaitingEmail] = useState(false);

  const requirements = useMemo(() => orgRequirements(denials, data?.locked ?? []), [denials, data]);
  const requirement = strongestRequirement(requirements.map((r) => r.code)) ?? 'org_reauthentication_required';

  const unlocked = async () => {
    toast.success('Confirmed. Your organization drives are open again.');
    dismiss();
    setAwaitingEmail(false);
    await Promise.all([mutate(() => true), fetchDrives(false, true), refreshLocked()]);
  };

  useEffect(() => {
    completeEmailedReauthentication(window.location)
      .then((done) => (done ? unlocked() : undefined))
      .catch(() => toast.error('That confirmation link could not be used here. Try again from this browser.'));
    // Runs once, on landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = async () => {
    setBusy(true);
    try {
      const outcome = await reauthenticateCurrentSession(requirement);
      if (outcome.status === 'awaiting_email') setAwaitingEmail(true);
      else await unlocked();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      toast.error(
        message === 'no_passkey'
          ? 'Strong sign-in needs a passkey. Add one in Settings → Account, then try again.'
          : 'That did not complete. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const strong = requirement === 'org_strong_sign_in_required';
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : dismiss())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Lock className="h-4 w-4" />Confirm it&rsquo;s you</DialogTitle>
          <DialogDescription>
            Your account is fine. Organization drives stay locked for this sign-in until you confirm it is you; your personal drives are not affected.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm" aria-label="What each organization requires">
          {requirements.map((r) => <li key={r.key}>{describeOrgSignInRequirement(r.code, r.orgName)}</li>)}
        </ul>
        {awaitingEmail ? (
          <p className="text-sm text-muted-foreground" role="status">We emailed you a confirmation link. Open it in this browser to finish.</p>
        ) : null}
        {!strong ? (
          <p className="text-xs text-muted-foreground">Signed in with Google or Apple and no passkey? Sign out and sign in again with them; that also counts as a fresh sign-in.</p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={dismiss}>Not now</Button>
          <Button onClick={() => void confirm()} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <KeyRound className="mr-1.5 h-4 w-4" />}
            {strong ? 'Use your passkey' : 'Confirm it’s you'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
