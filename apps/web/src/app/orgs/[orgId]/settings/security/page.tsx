'use client';

import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { Copy, Info, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useOrgAdminRead } from '@/hooks/useOrgs';
import { OrgBadge } from '@/components/orgs/OrgBadge';
import { OrgSettingsShell, type OrgSettingsContext } from '@/components/orgs/OrgSettingsShell';
import { del, post } from '@/lib/auth/auth-fetch';
import { isOrgKey } from '@/lib/orgs/org-api';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { formatOrgLongDate } from '@/lib/orgs/org-format';

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

      <Card>
        <CardHeader>
          <CardTitle>Sign-in requirements</CardTitle>
          <CardDescription>Requiring two-step sign-in and a maximum session age for members are not available yet. Each person&rsquo;s own account settings apply.</CardDescription>
        </CardHeader>
      </Card>

      <div className="flex gap-2.5 rounded-lg bg-muted p-3 text-[13px] leading-[18px]">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span>Single sign-on (SSO) and SCIM user provisioning are not part of organizations yet.</span>
      </div>
    </div>
  );
}

export default function OrgSecurityPage() {
  return (
    <OrgSettingsShell title="Security" description={(orgName) => `Verified domains and sign-in rules for ${orgName}.`}>
      {(ctx) => <SecurityBody {...ctx} />}
    </OrgSettingsShell>
  );
}
