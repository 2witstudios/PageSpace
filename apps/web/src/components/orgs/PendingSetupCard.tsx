'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { orgReadyForSetup } from '@/lib/orgs/create-org-flow';
import { clearPendingSetup, loadPendingSetup, type PendingOrgSetup } from '@/lib/orgs/pending-setup';
import { runOrgSetup } from '@/lib/orgs/run-org-setup';
import { useAuthStore } from '@/stores/useAuthStore';
import type { OrgBillingNotice } from '@pagespace/lib/organizations/status-core';

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Finishes a create-organization setup that a checkout left behind (review P2-7): once the org is paid, the
 * drives chosen in the dialog move in and the invitations go out, exactly as the dialog would have done.
 */
export function PendingSetupCard({ orgId, orgName, notice, onDone }: { orgId: string; orgName: string; notice: OrgBillingNotice | undefined; onDone: () => void }) {
  const userId = useAuthStore((state) => state.user?.id) ?? '';
  const [plan, setPlan] = useState<PendingOrgSetup | null>(null);
  const [running, setRunning] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);

  useEffect(() => setPlan(loadPendingSetup(userId, orgId)), [userId, orgId]);

  if (!plan) return null;
  const ready = orgReadyForSetup(notice);
  const what = [plan.driveIds.length ? `move ${plural(plan.driveIds.length, 'drive')} in` : null, plan.invites.length ? `invite ${plural(plan.invites.length, 'person')}`.replace('persons', 'people') : null].filter(Boolean).join(' and ');

  const finish = async () => {
    setRunning(true);
    const failed = await runOrgSetup(orgId, plan);
    clearPendingSetup(userId, orgId);
    setRunning(false);
    setFailures(failed);
    if (failed.length === 0) {
      toast.success(`${orgName} is set up`);
      setPlan(null);
    }
    onDone();
  };

  return (
    <div role="status" className="mb-8 flex flex-col gap-2 rounded-xl border bg-card px-3.5 py-3">
      <span className="text-sm font-medium">Finish setting up {orgName}</span>
      <span className="text-xs text-muted-foreground">
        {ready
          ? `When you created ${orgName} you chose to ${what}. That runs now that the first payment went through.`
          : `You chose to ${what}. That runs once the first payment goes through.`}
      </span>
      {failures.length > 0 ? (
        <ul className="list-disc pl-5 text-xs text-destructive">
          {failures.map((f) => <li key={f}>{f}</li>)}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={!ready || running || failures.length > 0} onClick={() => void finish()}>
          {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Finish setup
        </Button>
        <Button size="sm" variant="ghost" disabled={running} onClick={() => { clearPendingSetup(userId, orgId); setPlan(null); }}>
          {failures.length > 0 ? 'Dismiss' : 'Skip'}
        </Button>
      </div>
    </div>
  );
}
