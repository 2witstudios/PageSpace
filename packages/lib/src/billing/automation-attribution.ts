/**
 * automation-attribution — which automation a call's spend is listed under (Spec SPEND-10).
 *
 * PURE. A run no person is present for (a cron, a trigger, a scheduled workflow, a Zoom connection's
 * transcript enrichment) spends the drive wallet on behalf of its creator ([D-OW-34]), so its usage is
 * recorded as that person; the automation reference recorded beside it (credit_ledger.automationRef,
 * ai_usage_logs.automation_ref) lets the drive lead see that spend as the automation rather than merged
 * into the creator. A person's action — a manual Run, a channel mention — and a person's own call are
 * theirs (SPEND-6) and name no automation.
 *
 * The reference is a discriminated value with ONE codec here: `workflow:<id>` | `zoom:<connectionId>`.
 * Nothing else builds or splits the stored string.
 */

import type { SpendTarget } from './spend-target';

/** The automation a call's spend belongs to. */
export type AutomationRef =
  | { kind: 'workflow'; workflowId: string }
  /** A Zoom connection's transcript enrichment: an automation with no workflow behind it. */
  | { kind: 'zoom'; connectionId: string };

const PREFIX: Record<AutomationRef['kind'], string> = { workflow: 'workflow:', zoom: 'zoom:' };

/** The stored form of a reference. */
export function encodeAutomationRef(ref: AutomationRef): string {
  return ref.kind === 'workflow' ? `${PREFIX.workflow}${ref.workflowId}` : `${PREFIX.zoom}${ref.connectionId}`;
}

/** A stored reference, read back; null for anything this codec did not write (never guessed). */
export function parseAutomationRef(stored: string | null | undefined): AutomationRef | null {
  if (typeof stored !== 'string') return null;
  const id = (prefix: string): string | null => (stored.startsWith(prefix) && stored.length > prefix.length ? stored.slice(prefix.length) : null);
  const workflowId = id(PREFIX.workflow);
  if (workflowId !== null) return { kind: 'workflow', workflowId };
  const connectionId = id(PREFIX.zoom);
  return connectionId !== null ? { kind: 'zoom', connectionId } : null;
}

/** The stored reference for a workflow run's spend, when no person is present for it; else none. */
export function automationRefFor(target: SpendTarget, workflowId: string | null | undefined): string | undefined {
  if (target.kind !== 'automation' || target.personPresent === true) return undefined;
  return typeof workflowId === 'string' && workflowId.length > 0 ? encodeAutomationRef({ kind: 'workflow', workflowId }) : undefined;
}

/** What the drive lead's spend list calls a Zoom connection's enrichment. */
export const ZOOM_TRANSCRIPTS_AUTOMATION_NAME = 'Zoom transcripts';
