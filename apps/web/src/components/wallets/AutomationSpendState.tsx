'use client';

import { UserX } from 'lucide-react';
import { automationSpendCopy } from '@pagespace/lib/billing/spend-surface';
import { automationSkipCopy } from '@pagespace/lib/billing/spend-refusal-copy';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { runSkipReason, type AutomationRunState } from '@pagespace/lib/billing/automation-run-record';
import { useAutomationSpendContext } from '@/hooks/useAutomationSpendContext';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** What the automation surfaces know about where a drive's automations spend (orgs on only). */
export interface AutomationSpendContext {
  /** Drive members' names by user id. */
  creatorNames: Record<string, string>;
  /** The drive wallet's label ("Product wallet"), when the drive has one. */
  walletLabel: string | null;
  /** The drive's org, for "is no longer in <org>"; null on a personal drive. */
  orgName: string | null;
}

/**
 * The line under an automation's name (Spec SPEND-6; canvas v9 SpendSource "Automation"): it
 * spends as its creator (D-OW-34), or — when its creator left the org or deleted their account —
 * it is disabled and flagged for an Owner or Admin to reassign or delete (D-OW-36).
 */
export function AutomationSpendLine({ creatorName, walletLabel, ownerLeft }: { creatorName: string | null; walletLabel: string | null; ownerLeft: boolean }) {
  if (ownerLeft) {
    return (
      <span data-testid="automation-owner-left" className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline" className="gap-1 border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300">
          <UserX className="h-3 w-3" aria-hidden="true" />
          Owner left
        </Badge>
        Disabled until an org Owner or Admin reassigns or deletes it.
      </span>
    );
  }
  const copy = automationSpendCopy({ creatorName, walletLabel });
  return (
    <span data-testid="automation-spends-as" className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs font-normal text-muted-foreground">
      {copy.line && <span>{copy.line}</span>}
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="cursor-default font-normal">{copy.badge}</Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="text-xs">{copy.detail}</p>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

/** A skipped run's badge, with why in its tooltip (SPEND-6: a skip is logged, never silent). */
export function AutomationSkippedBadge({ state, creatorName, context }: { state: Extract<AutomationRunState, { kind: 'skipped' }>; creatorName: string | null; context: AutomationSpendContext }) {
  const why = automationSkipCopy({ reason: state.reason, walletLabel: context.walletLabel, creatorName, orgName: context.orgName });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" data-testid="automation-skipped" aria-label={why}>Skipped</Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="text-xs">{why}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** Whether a trigger's recorded error is a spend skip the surfaces explain (orgs on only). */
export const isSpendSkip = (error: string | null | undefined): boolean => ORGS_ENABLED && runSkipReason(error) !== null;

/**
 * A trigger's last run, when it was skipped for spend or a departed creator (SPEND-6): why, in the
 * one skip copy, instead of the raw run error. Renders nothing for any other error.
 */
export function AutomationSkipNote({ error, driveId, creatorId = null, className }: { error: string | null | undefined; driveId: string | null; creatorId?: string | null; className?: string }) {
  const context = useAutomationSpendContext(driveId);
  const reason = runSkipReason(error);
  if (!context || !reason) return null;
  const name = creatorId ? context.creatorNames[creatorId] ?? null : null;
  return (
    <p data-testid="automation-skip-note" className={className ?? 'text-xs text-muted-foreground'}>
      {automationSkipCopy({ reason, walletLabel: context.walletLabel, creatorName: name, orgName: context.orgName })}
    </p>
  );
}
