'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { formatCreditCount } from '@pagespace/lib/billing/money-model';
import { DEFAULT_SEAT_ALLOWANCE_CENTS } from '@pagespace/lib/billing/wallet-core';
import type { OrgPolicies, OrgPoliciesPatch } from '@pagespace/lib/organizations/policies-core';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useOrgAdminRead } from '@/hooks/useOrgs';
import { useEditingStore } from '@/stores/useEditingStore';
import { OrgSettingsShell, PausedWhileUnpaid, type OrgSettingsContext } from '@/components/orgs/OrgSettingsShell';
import { AI_PROVIDERS } from '@/lib/ai/core/ai-providers-config';
import { ApiRequestError, fetchJSON } from '@/lib/auth/auth-fetch';
import { isOrgKey, orgReadKeys, patchOrgPolicies } from '@/lib/orgs/org-api';
import { orgErrorCode, orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { policyChangeAllowed } from '@/lib/orgs/org-lapse';
import { allowlistLabel, policyChangeSummary, toggleAllowlist } from '@/lib/orgs/org-policies';
import { parseCreditsInput } from '@/lib/orgs/org-members';
import { cn } from '@/lib/utils/index';

interface PatchResult {
  suspended?: Record<string, number>;
  restored?: Record<string, number>;
  blocked?: Record<string, number>;
}

const SWITCH_LABELS = {
  publicShareLinks: 'Public share links',
  publishWeb: 'Publish pages to the web',
  customDomains: 'Custom domains',
  agentsAutonomous: 'Agents can run on their own',
  crossDriveAgents: 'Agents from other drives can be added as members',
  cloudSandbox: 'Cloud sandbox',
  persistentEnvironments: 'Persistent environments',
  publishedApps: 'Published apps',
} as const;

const PROVIDER_IDS = Object.keys(AI_PROVIDERS) as Array<keyof typeof AI_PROVIDERS>;
const providerName = (id: string) => (AI_PROVIDERS as Record<string, { name: string }>)[id]?.name ?? id;

function Row({ title, description, children, hint }: { title: string; description: React.ReactNode; children?: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t px-4 py-3.5 first:border-t-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">{description}</span>
        {hint}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">{title}</h2>
      <div className="overflow-hidden rounded-lg border bg-card">{children}</div>
    </section>
  );
}

function PoliciesBody({ orgId, orgName, role, lapsed }: OrgSettingsContext) {
  const { mutate } = useSWRConfig();
  const policies = useOrgAdminRead<{ policies: OrgPolicies }>(orgReadKeys.policies(orgId), role).data?.policies;
  const integrations = useSWR<{ providers: { slug: string; name: string }[] }>('/api/integrations/providers', (url: string) => fetchJSON(url), { revalidateOnFocus: false }).data?.providers;
  const [saving, setSaving] = useState<string | null>(null);
  const [floorDrives, setFloorDrives] = useState<{ id: string; name: string }[] | null>(null);
  const [allowance, setAllowance] = useState('');
  const [pickModels, setPickModels] = useState(false);

  useEffect(() => {
    if (policies && !useEditingStore.getState().isAnyEditing()) setAllowance(formatCreditCount(policies.seatAllowanceCents));
    if (policies) setPickModels(policies.modelAllowlist !== null);
  }, [policies]);

  const integrationSlugs = useMemo(() => (integrations ?? []).map((p) => p.slug), [integrations]);
  const modelCatalog = useMemo(() => {
    const allowed = policies?.providerAllowlist ?? PROVIDER_IDS;
    return PROVIDER_IDS.filter((p) => allowed.includes(p)).flatMap((p) =>
      Object.entries((AI_PROVIDERS as Record<string, { models: Record<string, string> }>)[p].models).map(([id, label]) => ({ id, label, provider: p })),
    );
  }, [policies?.providerAllowlist]);

  if (!policies) return <p className="text-sm text-muted-foreground">Loading policies…</p>;

  const can = (patch: OrgPoliciesPatch) => policyChangeAllowed(lapsed, policies, patch);

  const save = async (key: string, patch: OrgPoliciesPatch) => {
    setSaving(key);
    setFloorDrives(null);
    try {
      const result = (await patchOrgPolicies(orgId, patch as Record<string, unknown>)) as PatchResult;
      toast.success(policyChangeSummary({ suspended: result.suspended ?? {}, restored: result.restored ?? {}, blocked: result.blocked ?? {} }));
      void mutate((k) => isOrgKey(orgId, k));
    } catch (error) {
      const body = error instanceof ApiRequestError ? (error.body as { policy?: string; drives?: { id: string; name: string }[] } | undefined) : undefined;
      if (orgErrorCode(error) === 'org_policy' && body?.policy === 'openDriveRoleFloor' && body.drives) setFloorDrives(body.drives);
      else toast.error(orgErrorMessage(error, 'The policy could not be changed.'));
    } finally {
      setSaving(null);
    }
  };

  const toggle = (key: keyof typeof SWITCH_LABELS) => {
    const next = !policies[key];
    const allowed = can({ [key]: next });
    return {
      control: (
        <Switch
          aria-label={SWITCH_LABELS[key]}
          checked={policies[key]}
          disabled={saving !== null || !allowed}
          onCheckedChange={(checked) => void save(key, { [key]: checked })}
          className={cn(!allowed && 'opacity-50')}
        />
      ),
      hint: lapsed ? (allowed ? <PausedWhileUnpaid>Turning this off works while unpaid.</PausedWhileUnpaid> : <PausedWhileUnpaid />) : undefined,
    };
  };

  const select = <K extends 'guests' | 'whoCanInvite' | 'whoCanCreateDrives' | 'openDriveRoleFloor' | 'walletFallback'>(
    key: K,
    label: string,
    options: { value: OrgPolicies[K]; label: string }[],
  ) => (
    <Select value={policies[key] as string} disabled={saving !== null} onValueChange={(v) => void save(key, { [key]: v } as OrgPoliciesPatch)}>
      <SelectTrigger aria-label={label} className="h-8 w-[168px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value as string} value={o.value as string} disabled={!can({ [key]: o.value } as OrgPoliciesPatch)}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const allowanceInput = parseCreditsInput(allowance);
  const allowanceCents = allowanceInput.ok && allowanceInput.cents !== null ? allowanceInput.cents : null;
  const allowanceChanged = allowanceCents !== null && allowanceCents !== policies.seatAllowanceCents;
  const share = toggle('publicShareLinks');
  const publish = toggle('publishWeb');
  const domains = toggle('customDomains');
  const autonomous = toggle('agentsAutonomous');
  const crossDrive = toggle('crossDriveAgents');
  const sandbox = toggle('cloudSandbox');
  const envs = toggle('persistentEnvironments');
  const apps = toggle('publishedApps');

  return (
    <div className="space-y-8">
      <Group title="Sharing & access">
        <Row
          title="Guests from outside the organization"
          description="On, Admins approve, or Off. Guests do not use a seat and only see what they were invited to."
          hint={lapsed ? <PausedWhileUnpaid>Off is available. On is paused while unpaid.</PausedWhileUnpaid> : undefined}
        >
          {select('guests', 'Guests from outside the organization', [
            { value: 'on', label: 'On' },
            { value: 'approve', label: 'Admins approve' },
            { value: 'off', label: 'Off' },
          ])}
        </Row>
        <Row title="Public share links" description="Links that grant drive or page access to anyone who has them." hint={share.hint}>{share.control}</Row>
        <Row title="Publish pages to the web" description="Publishing a page or a site from an org drive." hint={publish.hint}>{publish.control}</Row>
        <Row title="Custom domains" description="Attach a domain to a published site." hint={domains.hint}>{domains.control}</Row>
      </Group>

      <Group title="Membership">
        <Row title="Who can invite new members" description="Members or Owner & admins. A new member uses a seat as soon as the invite is sent.">
          {select('whoCanInvite', 'Who can invite new members', [
            { value: 'members', label: 'Members' },
            { value: 'admins', label: 'Owner & admins' },
          ])}
        </Row>
        <Row title="Who can create org drives" description={`Members or Owner & admins. Drives created here are owned and paid for by ${orgName}.`}>
          {select('whoCanCreateDrives', 'Who can create org drives', [
            { value: 'members', label: 'Members' },
            { value: 'admins', label: 'Owner & admins' },
          ])}
        </Row>
        <Row
          title="Lowest default role in Open drives"
          description="A floor, View or Edit. Each Open drive picks its own default role for members who were never invited, at or above this."
        >
          {select('openDriveRoleFloor', 'Lowest default role in Open drives', [
            { value: 'view', label: 'View' },
            { value: 'edit', label: 'Edit' },
          ])}
        </Row>
        <div className="flex items-start gap-2 border-t bg-background px-4 py-3.5 text-[13px] leading-[18px] text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            With an <b>Edit</b> floor, a new drive can&rsquo;t start Open. Create it Restricted, give it an Edit default role, then switch it to Open.
          </span>
        </div>
        {floorDrives ? (
          <div className="border-t px-4 py-3.5">
            <Alert variant="destructive">
              <AlertDescription>
                <span>These Open drives have a default role below Edit. Give each one an Edit default role, or make it Restricted, then raise the floor:</span>
                <ul className="mt-1 list-disc pl-5">
                  {floorDrives.map((d) => (
                    <li key={d.id}>
                      <Link className="underline" href={`/dashboard/${d.id}/settings`}>{d.name}</Link>
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
      </Group>

      <Group title="AI & agents">
        <Row title="When a drive wallet runs out" description="Use seat allowance, use own credits, or refuse. Applies once an org drive has spent its monthly allocation.">
          {select('walletFallback', 'When a drive wallet runs out', [
            { value: 'seat_allowance', label: 'Use seat allowance' },
            { value: 'own_credits', label: 'Use own credits' },
            { value: 'refuse', label: 'Refuse' },
          ])}
        </Row>
        <Row
          title="Seat allowance"
          description={`Each member's monthly share of the org pool, spent inside org drives. ${formatCreditCount(DEFAULT_SEAT_ALLOWANCE_CENTS)} credits unless changed; there is no unlimited allowance. Personal drives still use their own credits.`}
          hint={lapsed ? <PausedWhileUnpaid>Can be lowered. Raising it is paused while unpaid.</PausedWhileUnpaid> : !allowanceInput.ok ? <span className="text-xs text-destructive">Enter a whole number of credits.</span> : undefined}
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="Seat allowance in credits a month"
              inputMode="numeric"
              className="h-8 w-28"
              value={allowance}
              onFocus={() => useEditingStore.getState().startEditing('org-seat-allowance', 'form')}
              onBlur={() => useEditingStore.getState().endEditing('org-seat-allowance')}
              onChange={(e) => setAllowance(e.target.value)}
            />
            <span className="whitespace-nowrap text-xs text-muted-foreground">credits a month</span>
            <Button
              size="sm"
              variant="outline"
              disabled={saving !== null || !allowanceChanged || (allowanceCents !== null && !can({ seatAllowanceCents: allowanceCents }))}
              onClick={() => allowanceCents !== null && void save('seatAllowanceCents', { seatAllowanceCents: allowanceCents })}
            >
              Save
            </Button>
          </div>
        </Row>
        <div className="flex flex-col gap-2 border-t px-4 py-3.5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">AI providers</span>
              <span className="text-[13px] leading-[18px] text-muted-foreground">Only checked providers can be used in org drives. Unrestricted allows every provider.</span>
            </div>
            <Button size="sm" variant="ghost" disabled={saving !== null || policies.providerAllowlist === null || !can({ providerAllowlist: null })} onClick={() => void save('providerAllowlist', { providerAllowlist: null })}>
              {allowlistLabel(policies.providerAllowlist, PROVIDER_IDS.length) === 'Unrestricted' ? 'Unrestricted' : 'Allow every provider'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {PROVIDER_IDS.map((id) => {
              const on = policies.providerAllowlist === null || policies.providerAllowlist.includes(id);
              const next = toggleAllowlist(policies.providerAllowlist, id, PROVIDER_IDS);
              return (
                <label key={id} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={on} disabled={saving !== null || !can({ providerAllowlist: next })} onCheckedChange={() => void save('providerAllowlist', { providerAllowlist: next })} aria-label={providerName(id)} />
                  {providerName(id)}
                </label>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t px-4 py-3.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">Models</span>
              <span className="text-[13px] leading-[18px] text-muted-foreground">Allow every model from the providers above, or pick individual models.</span>
            </div>
            <Select
              value={pickModels ? 'pick' : 'every'}
              disabled={saving !== null}
              onValueChange={(v) => {
                if (v === 'every') void save('modelAllowlist', { modelAllowlist: null });
                else setPickModels(true);
              }}
            >
              <SelectTrigger aria-label="Models" className="h-8 w-[168px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="every" disabled={!can({ modelAllowlist: null })}>Every model</SelectItem>
                <SelectItem value="pick">Pick models</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {pickModels ? (
            <div className="max-h-64 overflow-y-auto rounded-md border bg-background p-2">
              {modelCatalog.map((m) => {
                const ids = modelCatalog.map((x) => x.id);
                const on = policies.modelAllowlist === null || policies.modelAllowlist.includes(m.id);
                const next = toggleAllowlist(policies.modelAllowlist, m.id, ids);
                return (
                  <label key={m.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <Checkbox checked={on} disabled={saving !== null || !can({ modelAllowlist: next })} onCheckedChange={() => void save('modelAllowlist', { modelAllowlist: next })} aria-label={m.label} />
                    <span className="truncate">{m.label}</span>
                    <span className="text-xs text-muted-foreground">{providerName(m.provider)}</span>
                  </label>
                );
              })}
            </div>
          ) : null}
        </div>
        <Row
          title="Agents can run on their own"
          description="Triggers, scheduled workflows, and channel mentions without a person in the loop. A scheduled run spends as the person who created it; a mention or a manual Run spends as whoever triggered it."
          hint={autonomous.hint}
        >
          {autonomous.control}
        </Row>
        <Row title="Agents from other drives can be added as members" description="An agent that lives in a personal drive may be invited into an org drive." hint={crossDrive.hint}>
          {crossDrive.control}
        </Row>
      </Group>

      <Group title="Compute & integrations">
        <Row title="Cloud sandbox" description="Run code and open a terminal inside org drives. Billed to the organization." hint={sandbox.hint}>{sandbox.control}</Row>
        <Row title="Persistent environments" description="Machines a drive returns to between sessions." hint={envs.hint}>{envs.control}</Row>
        <Row title="Published apps" description="Host an app from an org drive on a PageSpace subdomain or custom domain." hint={apps.hint}>{apps.control}</Row>
        <div className="flex flex-col gap-2 border-t px-4 py-3.5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">Service connections</span>
              <span className="text-[13px] leading-[18px] text-muted-foreground">External services a drive may connect. Unchecked services cannot be added.</span>
            </div>
            <Button size="sm" variant="ghost" disabled={saving !== null || policies.integrationsAllowlist === null || !can({ integrationsAllowlist: null })} onClick={() => void save('integrationsAllowlist', { integrationsAllowlist: null })}>
              {policies.integrationsAllowlist === null ? 'Unrestricted' : 'Allow every service'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {(integrations ?? []).map((p) => {
              const on = policies.integrationsAllowlist === null || policies.integrationsAllowlist.includes(p.slug);
              const next = toggleAllowlist(policies.integrationsAllowlist, p.slug, integrationSlugs);
              return (
                <label key={p.slug} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={on} disabled={saving !== null || !can({ integrationsAllowlist: next })} onCheckedChange={() => void save('integrationsAllowlist', { integrationsAllowlist: next })} aria-label={p.name} />
                  {p.name}
                </label>
              );
            })}
          </div>
        </div>
      </Group>

      <div className="flex gap-2.5 rounded-lg bg-muted p-3 text-[13px] leading-[18px]">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span>
          Changing a policy applies immediately. Existing share links, guests, or apps that a new rule forbids are suspended, not deleted, and listed in the{' '}
          <Link className="text-primary hover:underline" href={`/orgs/${orgId}/settings/audit`}>audit log</Link> so an admin can review them.
        </span>
      </div>
    </div>
  );
}

export default function OrgPoliciesPage() {
  return (
    <OrgSettingsShell title="Policies" description={(orgName) => `Rules that apply inside every drive ${orgName} owns. Personal drives are not affected.`}>
      {(ctx) => <PoliciesBody {...ctx} />}
    </OrgSettingsShell>
  );
}
