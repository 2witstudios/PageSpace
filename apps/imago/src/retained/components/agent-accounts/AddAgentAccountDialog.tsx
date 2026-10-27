'use client';

import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/retained/components/ui/dialog';
import type { AgentAccountScope } from '@/retained/hooks/useAgentAccounts';
import { AddAgentAccountForm } from './AddAgentAccountForm';

/**
 * Add an account for an agent (or, in personal settings, for your global assistant), in a dialog. The
 * form is AddAgentAccountForm; the account route uses the same form inline.
 */
export function AddAgentAccountDialog({ scope, open, onOpenChange, onCreated }: { readonly scope: AgentAccountScope; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onCreated: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add an account</DialogTitle>
          <DialogDescription>
            The agent uses this account to call one site&apos;s API. PageSpace keeps the key in a separate credential vault and adds it to each request itself — the agent never sees it. The site you connect to still receives the key with each request, as it would from you.
          </DialogDescription>
        </DialogHeader>
        <AddAgentAccountForm scope={scope} onCreated={() => { onCreated(); onOpenChange(false); }} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
