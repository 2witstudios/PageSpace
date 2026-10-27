'use client';

import React, { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/retained/components/ui/button';
import { Input } from '@/retained/components/ui/input';
import { Label } from '@/retained/components/ui/label';
import { Checkbox } from '@/retained/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/retained/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/retained/components/ui/select';
import { post } from '@/retained/lib/auth/auth-fetch';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { agentAccountsUrl, type AgentAccountScope } from '@/retained/hooks/useAgentAccounts';
import {
  accountRequestBody,
  canSubmitAccount,
  placementNeedsName,
  refusalCopyFor,
  type AccountOwnership,
  type AccountPlacement,
} from './agent-account-form.model';

/**
 * The add-an-account form, shared by the dialog on an agent page and the inline form on the account
 * route. It LEADS with a dedicated account for the agent; a personal login is stored only after the
 * explicit acknowledgment, and the acknowledgment given is recorded on the account (Λ3). The key is
 * validated and posted here, and nowhere else.
 */
export function AddAgentAccountForm({
  scope,
  onCreated,
  onCancel,
}: {
  readonly scope: AgentAccountScope;
  readonly onCreated: () => void;
  /** Called after the fields are cleared; a dialog closes here, the inline form has nothing to close. */
  readonly onCancel?: () => void;
}) {
  const mountId = useId();
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [placement, setPlacement] = useState<AccountPlacement>('bearer');
  const [placementName, setPlacementName] = useState('');
  const [ownership, setOwnership] = useState<AccountOwnership>('dedicated');
  const [acknowledged, setAcknowledged] = useState(false);
  const [allowGenericRequests, setAllowGenericRequests] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const dirty = name !== '' || origin !== '' || apiKey !== '';
  useEffect(() => {
    const componentId = `add-agent-account-${mountId}`;
    if (dirty) useEditingStore.getState().startEditing(componentId, 'form');
    else useEditingStore.getState().endEditing(componentId);
    return () => useEditingStore.getState().endEditing(componentId);
  }, [dirty, mountId]);

  const reset = () => {
    setName('');
    setOrigin('');
    setApiKey('');
    setPlacement('bearer');
    setPlacementName('');
    setOwnership('dedicated');
    setAcknowledged(false);
    setAllowGenericRequests(false);
  };

  const draft = { name, origin, apiKey, placement, placementName, ownership, acknowledged, submitting };
  const canSubmit = canSubmitAccount(draft);

  const submit = async () => {
    setSubmitting(true);
    try {
      await post(agentAccountsUrl(scope), accountRequestBody({ ...draft, allowGenericRequests }));
      toast.success('Account added. The key is stored in the credential vault; the agent will only ever see its name.');
      reset();
      onCreated();
    } catch (error) {
      toast.error(refusalCopyFor(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <RadioGroup value={ownership} onValueChange={(value) => setOwnership(value as AccountOwnership)} className="space-y-2">
        <div className="flex items-start gap-2">
          <RadioGroupItem value="dedicated" id={`${mountId}-dedicated`} className="mt-0.5" />
          <Label htmlFor={`${mountId}-dedicated`} className="font-normal leading-snug">
            <span className="font-medium">Create a dedicated account for this agent</span> (recommended). Make the agent its own account or key on the site, so the site&apos;s own permissions limit what it can do.
          </Label>
        </div>
        <div className="flex items-start gap-2">
          <RadioGroupItem value="personal" id={`${mountId}-personal`} className="mt-0.5" />
          <Label htmlFor={`${mountId}-personal`} className="font-normal leading-snug">
            Use a personal login I share with my agent
          </Label>
        </div>
      </RadioGroup>

      {ownership === 'personal' && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20 p-3">
          <Checkbox id={`${mountId}-ack`} checked={acknowledged} onCheckedChange={(value) => setAcknowledged(value === true)} className="mt-0.5" />
          <Label htmlFor={`${mountId}-ack`} className="font-normal leading-snug text-sm">
            This is a personal login I share with my agent. The agent will be able to act as me on this site, within the limits below.
          </Label>
        </div>
      )}

      <div className="space-y-1">
        <Label htmlFor={`${mountId}-name`}>Name</Label>
        <Input id={`${mountId}-name`} value={name} onChange={(event) => setName(event.target.value)} placeholder="Weather API" maxLength={100} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${mountId}-origin`}>Site address</Label>
        <Input id={`${mountId}-origin`} value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://api.example.com" />
        <p className="text-xs text-muted-foreground">The agent can use this key with this address only — not other sites, other ports, or redirects.</p>
      </div>
      <div className="space-y-1">
        <Label>How the site expects the key</Label>
        <Select value={placement} onValueChange={(value) => setPlacement(value as AccountPlacement)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bearer">Authorization: Bearer &lt;key&gt;</SelectItem>
            <SelectItem value="authorization">Authorization: &lt;key&gt;</SelectItem>
            <SelectItem value="header">A custom header</SelectItem>
            <SelectItem value="query">A query parameter</SelectItem>
          </SelectContent>
        </Select>
        {placementNeedsName(placement) && (
          <Input value={placementName} onChange={(event) => setPlacementName(event.target.value)} placeholder={placement === 'header' ? 'X-Api-Key' : 'api_key'} />
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${mountId}-key`}>API key</Label>
        <Input id={`${mountId}-key`} type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
      </div>
      <div className="flex items-start gap-2">
        <Checkbox id={`${mountId}-allow`} checked={allowGenericRequests} onCheckedChange={(value) => setAllowGenericRequests(value === true)} className="mt-0.5" />
        <Label htmlFor={`${mountId}-allow`} className="font-normal leading-snug text-sm">
          Let the agent make requests to this site without asking me each time (up to 60 an hour). Otherwise you approve each request in the chat.
        </Label>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            reset();
            onCancel?.();
          }}
        >
          Cancel
        </Button>
        <Button type="button" onClick={submit} disabled={!canSubmit}>
          Add account
        </Button>
      </div>
    </div>
  );
}
