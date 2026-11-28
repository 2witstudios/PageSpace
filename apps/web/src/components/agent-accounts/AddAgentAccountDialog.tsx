'use client';

import React, { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiRequestError, post } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { agentAccountsUrl, type AgentAccountScope } from '@/hooks/useAgentAccounts';

type Placement = 'bearer' | 'authorization' | 'header' | 'query';
type Mode = 'key' | 'google';

/** What a person can let the agent do with a Google account; each is one narrow Google permission. */
const GOOGLE_SERVICE_OPTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'gmail.read', label: 'Read email' },
  { id: 'gmail.modify', label: 'Draft, label and trash email' },
  { id: 'gmail.send', label: 'Send email (always asks you first)' },
  { id: 'calendar.read', label: 'Read the calendar' },
  { id: 'calendar', label: 'Read and change the calendar' },
  { id: 'drive.read', label: 'Read Drive files' },
  { id: 'drive', label: 'Read and change Drive files' },
];

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  acknowledgment_required: 'Confirm that this is a personal login you share with your agent.',
  origin_invalid: 'The site address must be an https:// address with no path, like https://api.example.com.',
  origins_empty: 'Enter the site address the key is for.',
  placement_invalid: 'That header or parameter name cannot carry the key.',
  key_invalid: 'The key looks empty or contains line breaks.',
  name_invalid: 'Give the account a name (up to 100 characters).',
  forbidden: 'Only a drive owner or admin can add an account to this agent.',
  services_empty: 'Choose at least one thing the agent may do.',
  not_configured: 'Agent accounts are not set up on this PageSpace deployment.',
  plane_unavailable: 'The credential service is unavailable. Try again later.',
};

/**
 * Add an account for an agent (or, in personal settings, for your global assistant). The dialog LEADS
 * with creating a dedicated account for the agent; a personal login is stored only after the explicit
 * acknowledgment, and the acknowledgment given is recorded on the account and shown in the list (Λ3).
 */
export function AddAgentAccountDialog({ scope, open, onOpenChange, onCreated }: { readonly scope: AgentAccountScope; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onCreated: () => void }) {
  const mountId = useId();
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [placement, setPlacement] = useState<Placement>('bearer');
  const [placementName, setPlacementName] = useState('');
  const [ownership, setOwnership] = useState<'dedicated' | 'personal'>('dedicated');
  const [acknowledged, setAcknowledged] = useState(false);
  const [allowGenericRequests, setAllowGenericRequests] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<Mode>('key');
  const [services, setServices] = useState<string[]>(['gmail.read']);
  const [autoApproveReads, setAutoApproveReads] = useState(true);

  const dirty = open && (name !== '' || origin !== '' || apiKey !== '');
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

  const needsName = placement === 'header' || placement === 'query';
  const canSubmitKey = name.trim() !== '' && origin.trim() !== '' && apiKey !== '' && (!needsName || placementName.trim() !== '') && (ownership === 'dedicated' || acknowledged) && !submitting;
  const canSubmitGoogle = name.trim() !== '' && services.length > 0 && (ownership === 'dedicated' || acknowledged) && !submitting;
  const canSubmit = mode === 'google' ? canSubmitGoogle : canSubmitKey;

  /** Off to Google's consent screen; Google brings the browser back and the account appears in the list. */
  const connectGoogle = async () => {
    setSubmitting(true);
    try {
      const { authorizeUrl } = await post<{ authorizeUrl: string }>('/api/agent-accounts/oauth/google/start', {
        owner: scope.kind === 'user' ? { kind: 'user' } : { kind: 'agent_page', agentPageId: scope.pageId },
        name: name.trim(),
        services,
        ownership,
        acknowledged: ownership === 'personal' && acknowledged,
        autoApproveReads,
        returnTo: `${window.location.pathname}${window.location.search}`,
      });
      window.location.assign(authorizeUrl);
    } catch (error) {
      const reason = error instanceof ApiRequestError ? error.message : '';
      toast.error(REFUSAL_COPY[reason] ?? 'Google could not be connected.');
      setSubmitting(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      await post(agentAccountsUrl(scope), {
        name: name.trim(),
        allowedOrigins: [origin.trim()],
        ownership,
        acknowledged: ownership === 'personal' && acknowledged,
        // A bearer token is stored as the token alone; the credential service adds "Bearer " when it sends it.
        kind: placement === 'bearer' ? 'bearer' : 'api_key',
        apiKey: placement === 'bearer' ? apiKey.trim().replace(/^bearer\s+/i, '') : apiKey,
        placement: placement === 'query' ? { in: 'query', name: placementName.trim() } : { in: 'header', name: placement === 'header' ? placementName.trim() : 'Authorization' },
        allowGenericRequests,
      });
      toast.success('Account added. The key is stored in the credential vault; the agent will only ever see its name.');
      reset();
      onCreated();
      onOpenChange(false);
    } catch (error) {
      const reason = error instanceof ApiRequestError ? error.message : error instanceof Error ? (/"error":"([a-z_]+)"/.exec(error.message)?.[1] ?? '') : '';
      toast.error(REFUSAL_COPY[reason] ?? 'The account could not be added.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add an account</DialogTitle>
          <DialogDescription>
            The agent uses this account to call one site&apos;s API. PageSpace keeps the key in a separate credential vault and adds it to each request itself — the agent never sees it. The site you connect to still receives the key with each request, as it would from you.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <RadioGroup value={mode} onValueChange={(value) => setMode(value as Mode)} className="grid grid-cols-2 gap-2">
            <Label htmlFor={`${mountId}-mode-key`} className="flex items-center gap-2 rounded-md border p-3 font-normal cursor-pointer">
              <RadioGroupItem value="key" id={`${mountId}-mode-key`} /> An API key or token
            </Label>
            <Label htmlFor={`${mountId}-mode-google`} className="flex items-center gap-2 rounded-md border p-3 font-normal cursor-pointer">
              <RadioGroupItem value="google" id={`${mountId}-mode-google`} /> A Google account
            </Label>
          </RadioGroup>

          <RadioGroup value={ownership} onValueChange={(value) => setOwnership(value as 'dedicated' | 'personal')} className="space-y-2">
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
            <Input id={`${mountId}-name`} value={name} onChange={(event) => setName(event.target.value)} placeholder={mode === 'google' ? 'Agent Google' : 'Weather API'} maxLength={100} />
          </div>
          {mode === 'google' && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>What the agent may do</Label>
                {GOOGLE_SERVICE_OPTIONS.map((option) => (
                  <div key={option.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`${mountId}-svc-${option.id}`}
                      checked={services.includes(option.id)}
                      onCheckedChange={(value) => setServices((current) => (value === true ? [...new Set([...current, option.id])] : current.filter((id) => id !== option.id)))}
                    />
                    <Label htmlFor={`${mountId}-svc-${option.id}`} className="font-normal text-sm">
                      {option.label}
                    </Label>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">Google asks only for these. Sending email, calendar invites and edits, Drive file changes, deleting for good and sharing always ask you first.</p>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox id={`${mountId}-reads`} checked={autoApproveReads} onCheckedChange={(value) => setAutoApproveReads(value === true)} className="mt-0.5" />
                <Label htmlFor={`${mountId}-reads`} className="font-normal leading-snug text-sm">
                  Let the agent read without asking me each time (up to 60 an hour). Changes ask you first.
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">You&apos;ll sign in to Google next. Choose the agent&apos;s own Google account if it has one. PageSpace stores the sign-in in its credential vault; the agent never sees it.</p>
            </div>
          )}
          {mode === 'key' && (
          <>
          <div className="space-y-1">
            <Label htmlFor={`${mountId}-origin`}>Site address</Label>
            <Input id={`${mountId}-origin`} value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://api.example.com" />
            <p className="text-xs text-muted-foreground">The agent can use this key with this address only — not other sites, other ports, or redirects.</p>
          </div>
          <div className="space-y-1">
            <Label>How the site expects the key</Label>
            <Select value={placement} onValueChange={(value) => setPlacement(value as Placement)}>
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
            {needsName && <Input value={placementName} onChange={(event) => setPlacementName(event.target.value)} placeholder={placement === 'header' ? 'X-Api-Key' : 'api_key'} />}
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
          </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={mode === 'google' ? connectGoogle : submit} disabled={!canSubmit}>
            {mode === 'google' ? 'Continue to Google' : 'Add account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
