'use client';

import { useEffect, useId, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { post } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { CopyValueButton } from './CopyValueButton';

interface RotateResponse {
  identity_assertion: string;
  agent_id: string;
  secret_version: number;
  revoked_existing_tokens: boolean;
}

type State =
  | { step: 'confirm'; revokeExistingTokens: boolean; busy: boolean; error: string | null }
  | { step: 'reveal'; secret: string; signedOut: boolean; saved: boolean };

const INITIAL: State = { step: 'confirm', revokeExistingTokens: false, busy: false, error: null };

/**
 * Rotate the signed-in agent's secret (ADR 0008 Decision 14) through the
 * existing `POST /api/agent/secret/rotate`, then show the new secret ONCE.
 * Held in the editing store while open: with "sign out everywhere" this very
 * session dies, and an auth refresh must not navigate away before the agent
 * has copied the only copy of its new secret.
 */
export function RotateAgentSecretDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [state, setState] = useState<State>(INITIAL);
  const sessionId = `agent-secret-rotate-${useId()}`;

  useEffect(() => {
    if (!open) return;
    useEditingStore.getState().startEditing(sessionId, 'form', { componentName: 'RotateAgentSecretDialog' });
    return () => useEditingStore.getState().endEditing(sessionId);
  }, [open, sessionId]);

  const close = () => {
    const signedOut = state.step === 'reveal' && state.signedOut;
    setState(INITIAL);
    onOpenChange(false);
    if (signedOut) window.location.href = '/auth/agent?mode=signin';
  };

  const rotate = async () => {
    if (state.step !== 'confirm') return;
    setState({ ...state, busy: true, error: null });
    try {
      const rotated = await post<RotateResponse>('/api/agent/secret/rotate', { revokeExistingTokens: state.revokeExistingTokens });
      setState({ step: 'reveal', secret: rotated.identity_assertion, signedOut: rotated.revoked_existing_tokens, saved: false });
    } catch {
      setState({ ...state, busy: false, error: 'Could not rotate the secret. Try again later.' });
    }
  };

  // While the new secret is on screen, the dialog only closes through "Done".
  const onDialogOpenChange = (next: boolean) => {
    if (!next && state.step === 'reveal') return;
    if (!next) close();
  };

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogContent>
        {state.step === 'confirm' ? (
          <>
            <DialogHeader>
              <DialogTitle>Rotate agent secret</DialogTitle>
              <DialogDescription>
                Your current secret stops working immediately. The new one is shown once.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-2">
              <Checkbox
                id="rotate-revoke-tokens"
                checked={state.revokeExistingTokens}
                onCheckedChange={(value) => setState({ ...state, revokeExistingTokens: value === true })}
              />
              <Label htmlFor="rotate-revoke-tokens" className="text-sm font-normal leading-snug">
                Also sign out everywhere and revoke this agent&apos;s tokens and keys (including this session)
              </Label>
            </div>
            {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={state.busy}>Cancel</Button>
              <Button type="button" onClick={rotate} disabled={state.busy}>
                {state.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
                Rotate secret
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Save your new secret</DialogTitle>
              <DialogDescription>
                This is the only time it is shown.{state.signedOut ? ' Every session was signed out; sign in again with the new secret.' : ''}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code data-testid="rotated-agent-secret" className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
                {state.secret}
              </code>
              <CopyValueButton value={state.secret} label="Copy new secret" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="rotate-saved" checked={state.saved} onCheckedChange={(value) => setState({ ...state, saved: value === true })} />
              <Label htmlFor="rotate-saved">I have saved my new secret</Label>
            </div>
            <DialogFooter>
              <Button type="button" onClick={close} disabled={!state.saved}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
