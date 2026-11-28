'use client';

import React, { useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { del, patch, post } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { usePageAgents } from '@/hooks/page-agents/usePageAgents';
import { agentAccountSettingsUrl, refusalOf, sendAccountChange, useAgentAccountSettings, type AgentAccountSettings } from '@/hooks/useAgentAccountSettings';

/** Canonical origins carry `:443`; people type them without it. */
const displayOrigin = (origin: string) => origin.replace(/:443$/, '');

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  origin_invalid: 'Each site must be an https:// address with no path, like https://api.example.com.',
  origins_empty: 'Keep at least one site.',
  origins_too_many: 'An account can have at most 20 sites.',
  limit_invalid: 'The hourly limit must be a whole number from 1 to 1,000.',
  until_invalid: 'The end date must be at least a few minutes from now.',
  expiry_invalid: 'Unattended use can last from a few minutes up to 90 days.',
  auto_approve_required: 'Turn on "Allow without asking" first — unattended runs cannot stop to ask you.',
  page_unavailable: 'You can only attach it to an agent you can edit.',
  not_a_consenter: 'Only the person who owns this account (or a drive owner who was an admin when it was added) can allow more.',
  consent_unavailable: 'Allowing more is not set up on this PageSpace deployment yet. You can still restrict the account.',
  conflict: 'Someone else changed this account meanwhile. Reopen it and try again.',
  account_unavailable: 'This account is no longer available to change.',
  plane_unavailable: 'The credential service is unavailable. Try again later.',
  step_up_required: 'Confirm it is you to allow more.',
  bindings_full: 'This account is already attached to as many agents as it can be. Detach one first.',
  delegation_unavailable: 'That unattended use was already stopped.',
};
const refusalCopy = (error: unknown, fallback: string) => REFUSAL_COPY[refusalOf(error)] ?? fallback;

/** The LOCAL calendar date of a deadline (toISOString would shift it a day for anyone west of UTC). */
const dateInputOf = (until: number | null) => {
  if (until === null) return '';
  const date = new Date(until);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
/** End of the chosen day, local time. */
const untilOf = (value: string): number | null => (value === '' ? null : new Date(`${value}T23:59:59`).getTime());

/**
 * What an account may do, as its owner (or a drive owner/admin, for an agent's account) decides (slice 2):
 * which sites, whether calls run without asking — up to a cap an hour, until a date — which of your agents a
 * personal account is attached to, and whether scheduled runs and workflows may use it. Anything that allows
 * MORE asks you to confirm it is you (passkey, or an email link); restricting never does.
 */
export function AgentAccountPermissionsDialog({
  accountId,
  ownerAgentPageId,
  open,
  onOpenChange,
  onChanged,
}: {
  readonly accountId: string | null;
  /** The agent page that owns the account, when it is an agent's account. */
  readonly ownerAgentPageId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChanged: () => void;
}) {
  const mountId = useId();
  const { settings, isLoading, error, mutate } = useAgentAccountSettings(open ? accountId : null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [autoApprove, setAutoApprove] = useState(false);
  const [maxUsesPerHour, setMaxUsesPerHour] = useState('60');
  const [untilDate, setUntilDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Load the stored permissions into the form whenever a fresh copy arrives and nothing is being edited.
  useEffect(() => {
    if (settings === null || dirty) return;
    setOrigins(settings.account.allowedOrigins.map(displayOrigin));
    setAutoApprove(settings.autoApprove !== null);
    setMaxUsesPerHour(String(settings.autoApprove?.maxUsesPerHour ?? 60));
    setUntilDate(dateInputOf(settings.autoApprove?.until ?? null));
  }, [settings, dirty]);

  useEffect(() => {
    const componentId = `agent-account-permissions-${mountId}`;
    if (open && dirty) useEditingStore.getState().startEditing(componentId, 'form');
    else useEditingStore.getState().endEditing(componentId);
    return () => useEditingStore.getState().endEditing(componentId);
  }, [open, dirty, mountId]);

  const close = (next: boolean) => {
    if (!next) setDirty(false);
    onOpenChange(next);
  };

  /** `savedForm`: this change WAS the permission form; anything else (attach, unattended use) leaves unsaved edits alone. */
  const applied = async (result: { settings: AgentAccountSettings } | 'awaiting_email', success: string, savedForm = false) => {
    if (result === 'awaiting_email') {
      toast.message('Check your email', { description: 'Open the link we sent you to confirm it is you; the change is applied when you come back.' });
      return;
    }
    await mutate(result.settings, { revalidate: false });
    if (savedForm) setDirty(false);
    onChanged();
    toast.success(success);
  };

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      toast.error(refusalCopy(failure, fallback));
    } finally {
      setBusy(false);
    }
  };

  const storedUntil = settings?.autoApprove?.until ?? null;
  const savePermissions = () =>
    run(async () => {
      if (accountId === null) return;
      const body = {
        allowedOrigins: origins.map((origin) => origin.trim()).filter((origin) => origin !== ''),
        autoApprove: autoApprove ? { enabled: true, maxUsesPerHour: Number(maxUsesPerHour), until: untilDate === dateInputOf(storedUntil) ? storedUntil : untilOf(untilDate) } : { enabled: false },
      };
      const url = agentAccountSettingsUrl(accountId);
      const result = await sendAccountChange({ accountId, method: 'PATCH', url, body }, (payload) => patch<{ settings: AgentAccountSettings }>(url, payload));
      await applied(result, 'Permissions saved.', true);
    }, 'The permissions could not be saved.');

  const isAgentAccount = settings?.account.ownerKind === 'agent_page';
  const { allAgents } = usePageAgents(undefined, { enabled: open && settings?.canBind === true, refreshInterval: 0 });
  const boundIds = useMemo(() => new Set(settings?.bindings.map((binding) => binding.agentPageId) ?? []), [settings]);
  const attachable = allAgents.filter((agent) => !boundIds.has(agent.id));
  const [attachTo, setAttachTo] = useState('');

  const attach = () =>
    run(async () => {
      if (accountId === null || attachTo === '') return;
      const url = `/api/agent-accounts/${accountId}/bindings`;
      const result = await sendAccountChange({ accountId, method: 'POST', url, body: { agentPageId: attachTo } }, (payload) => post<{ settings: AgentAccountSettings }>(url, payload));
      setAttachTo('');
      await applied(result, 'Attached. That agent can now use this account when you run it.');
    }, 'The account could not be attached.');

  const detach = (agentPageId: string) =>
    run(async () => {
      if (accountId === null) return;
      const result = await del<{ settings: AgentAccountSettings }>(`/api/agent-accounts/${accountId}/bindings/${agentPageId}`);
      await applied(result, 'Detached.');
    }, 'The account could not be detached.');

  // Which agent an unattended delegation is for: the owning agent, or one a personal account is attached to.
  const delegationTargets = isAgentAccount
    ? ownerAgentPageId === null
      ? []
      : [{ id: ownerAgentPageId, title: 'This agent' }]
    : (settings?.bindings ?? []).map((binding) => ({ id: binding.agentPageId, title: binding.title ?? 'An agent' }));
  const [delegateTo, setDelegateTo] = useState('');
  const [delegateDays, setDelegateDays] = useState('30');
  // A choice made for another account (or a target since detached) never carries over.
  const delegateTarget = delegationTargets.some((target) => target.id === delegateTo) ? delegateTo : (delegationTargets[0]?.id ?? '');

  const delegate = () =>
    run(async () => {
      if (accountId === null || delegateTarget === '') return;
      const url = `/api/agent-accounts/${accountId}/delegations`;
      const body = { agentPageId: delegateTarget, days: Number(delegateDays) };
      const result = await sendAccountChange({ accountId, method: 'POST', url, body }, (payload) => post<{ settings: AgentAccountSettings }>(url, payload));
      await applied(result, 'Scheduled runs and workflows you start can now use this account.');
    }, 'Unattended use could not be allowed.');

  const undelegate = (delegationId: string) =>
    run(async () => {
      if (accountId === null) return;
      const result = await del<{ settings: AgentAccountSettings }>(`/api/agent-accounts/${accountId}/delegations/${delegationId}`);
      await applied(result, 'Unattended use stopped.');
    }, 'Unattended use could not be stopped.');

  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    setDirty(true);
    setter(value);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Permissions{settings ? ` — ${settings.account.name}` : ''}</DialogTitle>
          <DialogDescription>Decide what this account can be used for. Restricting applies at once; allowing more asks you to confirm it is you. The agent never sees the key.</DialogDescription>
        </DialogHeader>

        {isLoading && <Skeleton className="h-40 w-full" />}
        {error && <p className="text-sm text-destructive">This account&apos;s permissions could not be loaded.</p>}

        {settings && (
          <div className="space-y-6">
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Sites</h3>
              <p className="text-xs text-muted-foreground">The account is sent only to these addresses — never other sites, other ports or redirects.</p>
              {origins.map((origin, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input value={origin} onChange={(event) => edit(setOrigins)(origins.map((value, at) => (at === index ? event.target.value : value)))} placeholder="https://api.example.com" aria-label={`Site ${index + 1}`} />
                  <Button type="button" variant="ghost" size="icon" disabled={origins.length <= 1} onClick={() => edit(setOrigins)(origins.filter((_, at) => at !== index))} aria-label="Remove site">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => edit(setOrigins)([...origins, ''])} disabled={origins.length >= 20}>
                <Plus className="h-4 w-4 mr-1" /> Add site
              </Button>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Approval</h3>
              <RadioGroup value={autoApprove ? 'auto' : 'ask'} onValueChange={(value) => edit(setAutoApprove)(value === 'auto')} className="space-y-2">
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="ask" id={`${mountId}-ask`} className="mt-0.5" />
                  <Label htmlFor={`${mountId}-ask`} className="font-normal leading-snug">
                    <span className="font-medium">Ask me before every request.</span> You approve each one in the chat.
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="auto" id={`${mountId}-auto`} className="mt-0.5" />
                  <Label htmlFor={`${mountId}-auto`} className="font-normal leading-snug">
                    <span className="font-medium">Allow requests to these sites without asking</span>, within the limits below.
                  </Label>
                </div>
              </RadioGroup>
              {autoApprove && (
                <div className="grid grid-cols-2 gap-3 pl-6">
                  <div className="space-y-1">
                    <Label htmlFor={`${mountId}-cap`}>Requests per hour</Label>
                    <Input id={`${mountId}-cap`} type="number" min={1} max={1000} value={maxUsesPerHour} onChange={(event) => edit(setMaxUsesPerHour)(event.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${mountId}-until`}>Until (optional)</Label>
                    <Input id={`${mountId}-until`} type="date" value={untilDate} onChange={(event) => edit(setUntilDate)(event.target.value)} />
                  </div>
                  <p className="col-span-2 text-xs text-muted-foreground">
                    Past the hourly limit, requests are refused until the hour rolls over.
                    {settings.usesThisHour !== null && settings.autoApprove !== null ? ` Used ${settings.usesThisHour} of ${settings.autoApprove.maxUsesPerHour} in the last hour.` : ''}
                  </p>
                </div>
              )}
              <div className="flex justify-end">
                <Button type="button" size="sm" onClick={savePermissions} disabled={busy || !dirty}>
                  Save permissions
                </Button>
              </div>
            </section>

            {settings.canBind && (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Agents that can use it</h3>
                <p className="text-xs text-muted-foreground">Attach this account to your agents. An attached agent can use it only when you run it — never for anyone else.</p>
                {settings.bindings.length === 0 && <p className="text-sm text-muted-foreground">Only your global assistant can use it.</p>}
                {settings.bindings.map((binding) => (
                  <div key={binding.agentPageId} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <span className="text-sm truncate">{binding.title ?? 'An agent you can no longer see'}</span>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => detach(binding.agentPageId)}>
                      Detach
                    </Button>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Select value={attachTo} onValueChange={setAttachTo}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Choose an agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {attachable.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.title || 'Unnamed agent'} · {agent.driveName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" size="sm" disabled={busy || attachTo === ''} onClick={attach}>
                    Attach
                  </Button>
                </div>
              </section>
            )}

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Scheduled runs and workflows</h3>
              <p className="text-xs text-muted-foreground">These run without you there to approve anything, so they can use the account only within &quot;Allow without asking&quot;, only when you started them, and only until the date you pick.</p>
              {settings.delegations.map((delegation) => (
                <div key={delegation.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <span className="text-sm truncate">
                    {delegation.title ?? (isAgentAccount ? 'This agent' : 'An agent')} · until {new Date(delegation.expiresAt).toLocaleDateString()}
                  </span>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => undelegate(delegation.id)}>
                    Stop
                  </Button>
                </div>
              ))}
              {settings.autoApprove === null ? (
                <p className="text-sm text-muted-foreground">Turn on &quot;Allow without asking&quot; and save to let scheduled runs use this account.</p>
              ) : delegationTargets.length === 0 ? (
                <p className="text-sm text-muted-foreground">Attach the account to an agent first.</p>
              ) : (
                <div className="flex items-center gap-2">
                  {delegationTargets.length > 1 && (
                    <Select value={delegateTarget} onValueChange={setDelegateTo}>
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {delegationTargets.map((target) => (
                          <SelectItem key={target.id} value={target.id}>
                            {target.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Select value={delegateDays} onValueChange={setDelegateDays}>
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">For 1 day</SelectItem>
                      <SelectItem value="7">For 7 days</SelectItem>
                      <SelectItem value="30">For 30 days</SelectItem>
                      <SelectItem value="90">For 90 days</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="button" size="sm" disabled={busy} onClick={delegate}>
                    Allow
                  </Button>
                </div>
              )}
            </section>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
