'use client';

import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { Copy, Info, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/retained/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/retained/components/ui/card';
import { Input } from '@/retained/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/retained/components/ui/select';
import { useOrgAdminRead } from '@/retained/hooks/useOrgs';
import { OrgBadge } from '@/retained/components/orgs/OrgBadge';
import { OrgSettingsShell, type OrgSettingsContext } from '@/retained/components/orgs/OrgSettingsShell';
import { ApiRequestError, del, patch, post } from '@/retained/lib/auth/auth-fetch';
import { Label } from '@/retained/components/ui/label';
import { Switch } from '@/retained/components/ui/switch';
import { isOrgSignInDenialCode } from '@/retained/lib/auth/org-sign-in-denial';
import { reauthenticateCurrentSession } from '@/retained/lib/auth/session-reauthentication';
import {
  SESSION_AGE_OPTIONS,
  SESSION_AGE_RANGE_TEXT,
  blockedPeopleText,
  formatSessionAge,
  isValidSessionAge,
  needsPasskeyBeforeSaving,
  signInPolicyPatch,
  signInPreviewQuery,
  type SignInBlockedCounts,
  type SignInPolicyDraft,
} from '@/retained/lib/orgs/sign-in-policy-ui';
import { isOrgKey, orgReadKeys, type OrgPolicies } from '@/retained/lib/orgs/org-api';
import { orgErrorMessage } from '@/retained/lib/orgs/org-error-copy';
import { formatOrgLongDate } from '@/retained/lib/orgs/org-format';

interface OrgDomain {
  id: string;
  domain: string;
  verifiedAt: string | null;
  verifiedMethod: 'dns' | 'email' | null;
  emailSentTo: string | null;
  emailTokenExpiresAt: string | null;
  dnsRecord: { type: 'TXT'; name: string; value: string };
}

const MAILBOXES = ['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster'] as const;

function DomainRow({ orgId, domain, onChanged }: { orgId: string; domain: OrgDomain; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [mailbox, setMailbox] = useState<(typeof MAILBOXES)[number]>('admin');
  const base = `/api/orgs/${orgId}/domains/${domain.id}`;

  const run = async (fn: () => Promise<unknown>, success: string, fallback: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      onChanged();
    } catch (error) {
      toast.error(orgErrorMessage(error, fallback));
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    toast.success('Copied');
  };

  return (
    <div className="flex flex-col gap-3 border-t px-4 py-3.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{domain.domain}</span>
        {domain.verifiedAt ? (
          <OrgBadge tone="live">Verified {domain.verifiedMethod === 'email' ? 'by email' : 'by DNS'}</OrgBadge>
        ) : (
          <OrgBadge tone="pending">Not verified</OrgBadge>
        )}
        <span className="ml-auto" />
        <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => void run(() => del(base), `${domain.domain} removed`, 'The domain could not be removed.')}>
          <Trash2 className="mr-1.5 h-4 w-4" />
          Remove
        </Button>
      </div>
      {domain.verifiedAt ? (
        <span className="text-xs text-muted-foreground">Verified {formatOrgLongDate(domain.verifiedAt)}. New sign-ups with this address join automatically while a seat is free.</span>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg bg-muted p-3 text-[13px]">
          <span>Add this TXT record at your DNS provider, then check it:</span>
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 font-mono text-xs">
            <span className="text-muted-foreground">Name</span>
            <span className="break-all">{domain.dnsRecord.name}</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Copy record name" onClick={() => copy(domain.dnsRecord.name)}><Copy className="h-3.5 w-3.5" /></Button>
            <span className="text-muted-foreground">Value</span>
            <span className="break-all">{domain.dnsRecord.value}</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Copy record value" onClick={() => copy(domain.dnsRecord.value)}><Copy className="h-3.5 w-3.5" /></Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run(() => post(`${base}/verify`, { method: 'dns' }), `${domain.domain} verified`, 'The domain could not be verified.')}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Check DNS
            </Button>
            <span className="text-xs text-muted-foreground">or email</span>
            <Select value={mailbox} onValueChange={(v) => setMailbox(v as (typeof MAILBOXES)[number])}>
              <SelectTrigger aria-label="Mailbox" className="h-8 w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MAILBOXES.map((m) => <SelectItem key={m} value={m}>{m}@{domain.domain}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => post(`${base}/verify`, { method: 'email', mailbox }), `Verification email sent to ${mailbox}@${domain.domain}`, 'The verification email could not be sent.')}>
              Send verification email
            </Button>
          </div>
          {domain.emailSentTo ? <span className="text-xs text-muted-foreground">A link was sent to {domain.emailSentTo}.</span> : null}
        </div>
      )}
    </div>
  );
}

function SecurityBody({ orgId, orgName, role }: OrgSettingsContext) {
  const { mutate } = useSWRConfig();
  const domains = useOrgAdminRead<{ domains: OrgDomain[] }>(`/api/orgs/${orgId}/domains`, role).data?.domains;
  const [newDomain, setNewDomain] = useState('');
  const [adding, setAdding] = useState(false);
  const [rejoin, setRejoin] = useState('');
  const refresh = () => void mutate((k) => isOrgKey(orgId, k));

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newDomain.trim()) return;
    setAdding(true);
    try {
      await post(`/api/orgs/${orgId}/domains`, { domain: newDomain.trim() });
      setNewDomain('');
      refresh();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The domain could not be added.'));
    } finally {
      setAdding(false);
    }
  };

  const clearSuppression = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const { cleared } = await post<{ cleared: boolean }>(`/api/orgs/${orgId}/suppressions/clear`, { email: rejoin.trim() });
      toast.success(cleared ? 'They can join again through a verified domain.' : 'Nothing was blocking that address.');
      setRejoin('');
    } catch (error) {
      toast.error(orgErrorMessage(error, 'That could not be cleared.'));
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Verified domains</CardTitle>
          <CardDescription>People who sign up with an address on a verified domain join {orgName} automatically, while a seat is free.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-hidden rounded-lg border bg-card">
            {(domains ?? []).length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">No domains yet.</div>
            ) : (
              (domains ?? []).map((d) => <DomainRow key={d.id} orgId={orgId} domain={d} onChanged={refresh} />)
            )}
          </div>
          <form onSubmit={add} className="flex gap-2">
            <Input aria-label="Domain" placeholder="northwind.com" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} className="max-w-xs" />
            <Button type="submit" size="sm" disabled={adding || !newDomain.trim()}>Add domain</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Removed people</CardTitle>
          <CardDescription>Someone removed from {orgName} is not let back in through a verified domain. Clear their address to let them rejoin that way.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={clearSuppression} className="flex gap-2">
            <Input aria-label="Email address to let rejoin" type="email" placeholder="lou@northwind.com" value={rejoin} onChange={(e) => setRejoin(e.target.value)} className="max-w-xs" />
            <Button type="submit" size="sm" variant="outline" disabled={!rejoin.trim()}>Let them rejoin</Button>
          </form>
        </CardContent>
      </Card>

      <SignInRequirementsCard orgId={orgId} orgName={orgName} role={role} />

      <section aria-labelledby="sec-out-of-scope" className="flex gap-2.5 rounded-lg bg-muted p-3 text-[13px] leading-[18px]">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <div>
          <h2 id="sec-out-of-scope" className="font-medium">Single sign-on and SCIM</h2>
          <p>Single sign-on (SSO) and SCIM user provisioning are out of scope for organizations. Members sign in with their own PageSpace sign-in methods.</p>
        </div>
      </section>
    </div>
  );
}

const NO_LIMIT = 'none';
const INVALID_AGE = 'invalid';

/**
 * SEC-2/SEC-3 (D-OW-45, D-OW-47): require strong sign-in (a user-verified passkey) and a maximum sign-in age for
 * everyone opening the org's drives, members and guests alike. Owners and Admins see, before saving, how many members
 * and guests would have to sign in again. Only the changed keys are sent, and a damaged stored age reads as invalid
 * until the Admin chooses a value. Turning strong sign-in on runs the passkey ceremony first: an Admin must meet a policy
 * themselves before they can turn it on, or they would lock themselves out of these settings.
 */
function SignInRequirementsCard({ orgId, orgName, role }: Pick<OrgSettingsContext, 'orgId' | 'orgName' | 'role'>) {
  const { mutate } = useSWRConfig();
  const stored = useOrgAdminRead<{ policies: OrgPolicies }>(orgReadKeys.policies(orgId), role).data?.policies;
  const [draft, setDraft] = useState<SignInPolicyDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const current: SignInPolicyDraft | null = draft ?? (stored ? { requireStrongSignIn: stored.requireStrongSignIn, maximumSessionAgeMinutes: stored.maximumSessionAgeMinutes } : null);
  const dirty = !!(draft && stored && Object.keys(signInPolicyPatch(stored, draft)).length > 0);
  // No preview of a damaged age: the preview only judges ages in the allowed range.
  const preview = useOrgAdminRead<SignInBlockedCounts>(
    dirty && draft && isValidSessionAge(draft.maximumSessionAgeMinutes) ? `/api/orgs/${orgId}/policies/sign-in-preview?${signInPreviewQuery(draft)}` : null,
    role,
  ).data;

  if (!current || !stored) return null;
  const age = current.maximumSessionAgeMinutes;
  const ageValid = isValidSessionAge(age);
  const ages = age === null || !ageValid || SESSION_AGE_OPTIONS.includes(age) ? SESSION_AGE_OPTIONS : [...SESSION_AGE_OPTIONS, age];

  const confirmFirst = async (requirement: 'org_strong_sign_in_required' | 'org_reauthentication_required'): Promise<boolean> => {
    const outcome = await reauthenticateCurrentSession(requirement);
    if (outcome.status === 'awaiting_email') {
      toast.info('We emailed you a confirmation link. Open it in this browser, then save again.');
      return false;
    }
    return true;
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (needsPasskeyBeforeSaving(stored, draft) && !(await confirmFirst('org_strong_sign_in_required'))) return;
      const body = signInPolicyPatch(stored, draft);
      const send = () => patch<{ signInBlocked: SignInBlockedCounts | null }>(orgReadKeys.policies(orgId), body);
      let result;
      try {
        result = await send();
      } catch (error) {
        const body = error instanceof ApiRequestError ? (error.body as { code?: unknown; requires?: unknown } | undefined) : undefined;
        if (body?.code !== 'org_policy_would_lock_out_actor' || !isOrgSignInDenialCode(body.requires)) throw error;
        if (!(await confirmFirst(body.requires))) return;
        result = await send();
      }
      const blocked = result.signInBlocked;
      const who = blocked ? blockedPeopleText(blocked) : '';
      const one = blocked !== null && blocked.members + blocked.guests === 1;
      toast.success(who ? `Saved. ${who} ${one ? 'needs' : 'need'} to sign in again to open ${orgName}'s drives.` : 'Saved.');
      setDraft(null);
      void mutate((k) => isOrgKey(orgId, k));
    } catch (error) {
      toast.error(orgErrorMessage(error, 'The sign-in requirements could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-in requirements</CardTitle>
        <CardDescription>
          These apply to everyone who opens {orgName}&rsquo;s drives, members and guests alike. Someone who does not meet them keeps their account and personal drives, and is asked to sign in again before opening the organization&rsquo;s drives.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="require-strong-sign-in">Require strong sign-in (passkey)</Label>
            <p className="text-xs text-muted-foreground">A passkey confirmed on the device (fingerprint, face or PIN). Emailed links, Google and Apple do not count.</p>
          </div>
          <Switch
            id="require-strong-sign-in"
            checked={current.requireStrongSignIn}
            onCheckedChange={(checked) => setDraft({ ...current, requireStrongSignIn: checked })}
          />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="maximum-session-age">Maximum sign-in age</Label>
            <p className="text-xs text-muted-foreground">How long a sign-in lasts before the organization asks for a fresh one. {SESSION_AGE_RANGE_TEXT}</p>
          </div>
          <Select
            value={age === null ? NO_LIMIT : ageValid ? String(age) : INVALID_AGE}
            onValueChange={(v) => setDraft({ ...current, maximumSessionAgeMinutes: v === NO_LIMIT ? null : Number(v) })}
          >
            <SelectTrigger id="maximum-session-age" aria-label="Maximum sign-in age" className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ageValid ? null : <SelectItem value={INVALID_AGE} disabled>Invalid — choose a value</SelectItem>}
              <SelectItem value={NO_LIMIT}>No limit</SelectItem>
              {ages.map((m) => <SelectItem key={m} value={String(m)}>{formatSessionAge(m)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          You have to meet a requirement yourself before you can turn it on, so you never lock yourself out: turning on strong sign-in first asks you to confirm with your passkey. Relaxing a requirement needs a sign-in that meets the one in force.
        </p>
        {dirty && preview ? (
          <p className="text-sm" role="status">
            {blockedPeopleText(preview)
              ? `${blockedPeopleText(preview)} would need to sign in again before opening ${orgName}'s drives.`
              : 'No one would need to sign in again.'}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {draft && needsPasskeyBeforeSaving(stored, draft) ? 'Confirm with passkey and save' : 'Save sign-in requirements'}
          </Button>
          {dirty ? <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function OrgSecurityPage() {
  return (
    <OrgSettingsShell title="Security" description={(orgName) => `Verified domains and sign-in rules for ${orgName}.`}>
      {(ctx) => <SecurityBody {...ctx} />}
    </OrgSettingsShell>
  );
}
