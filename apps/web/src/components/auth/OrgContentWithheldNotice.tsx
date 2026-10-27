'use client';

import { KeyRound, Lock } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { OrgContentSignInRequired } from '@/lib/auth/org-sign-in-denial';
import { useOrgReauthStore } from '@/stores/useOrgReauthStore';
import { cn } from '@/lib/utils';

export interface OrgContentWithheldNoticeProps {
  /** What is withheld, as the start of a sentence: "Your Pulse summary", "Your AI memory". */
  subject: string;
  signInRequired: OrgContentSignInRequired;
  className?: string;
}

/**
 * D-OW-62: content distilled from org drives (a Pulse summary, AI memory) that an org's sign-in policy withholds from
 * this sign-in. Says why, and the action opens the one re-authentication prompt (OrgReauthenticationPrompt) for every
 * refusing org, exactly as a refused drive does.
 */
export function OrgContentWithheldNotice({ subject, signInRequired, className }: OrgContentWithheldNoticeProps) {
  const report = useOrgReauthStore((s) => s.report);
  const strong = signInRequired.code === 'org_strong_sign_in_required';
  const reason = strong
    ? 'requires strong sign-in (passkey)'
    : 'asks you to sign in again: your sign-in is older than it allows';

  const openPrompt = () => {
    const orgIds = signInRequired.orgIds.length > 0 ? signInRequired.orgIds : [null];
    for (const orgId of orgIds) report({ code: signInRequired.code, orgId });
  };

  return (
    <Alert className={cn('pointer-events-auto text-left', className)}>
      <Lock className="h-4 w-4" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>{subject} is hidden because an organization it draws from {reason}.</span>
        <Button size="sm" variant="outline" onClick={openPrompt}>
          <KeyRound className="mr-1.5 h-4 w-4" />
          {strong ? 'Use your passkey' : 'Sign in again'}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
