/**
 * automation-run-record — the text a refused automation run records, and reading it back (Spec
 * SPEND-6, D-OW-34, D-OW-36).
 *
 * A workflow run, a task trigger and a calendar or webhook trigger store a refused run as its
 * error text (workflow_runs.error, lastFireError). That text is WRITTEN here and READ here only,
 * so the workflow and trigger surfaces can show why a run was skipped through
 * spend-refusal-copy without ever parsing a message they did not produce: the format and its
 * reader are one module, pinned by a round-trip test.
 *
 * PURE and client-safe.
 */
import type { GateReason } from './credit-core';
import type { SpendRefusal } from './credit-gate';
import { REFUSAL_REASONS, SKIP_REASONS } from './spend-refusal-copy';
import type { RefusalReason, SkipReason } from './wallet-core';

const PREFIX = 'AI credit gate denied: ';

/** The run error for a denied gate; a refused source adds why ("… (creator_departed)"). */
export const creditDeniedError = (reason: GateReason, refusal?: SpendRefusal): string =>
  refusal ? `${PREFIX}${reason} (${refusal.reason})` : `${PREFIX}${reason}`;

/** Exactly the shape creditDeniedError writes for a refusal: a gate reason, then a snake_case reason. */
const DENIED_WITH_REASON = /^AI credit gate denied: [a-z_]+ \(([a-z_]+)\)$/;

const KNOWN_REASONS: readonly (RefusalReason | SkipReason)[] = [...REFUSAL_REASONS, ...SKIP_REASONS];

/** The skip or refusal reason a run's error records, or null when it records none. */
export function runSkipReason(error: string | null | undefined): RefusalReason | SkipReason | null {
  if (!error) return null;
  const recorded = DENIED_WITH_REASON.exec(error)?.[1];
  return KNOWN_REASONS.find((reason) => reason === recorded) ?? null;
}

export type AutomationRunState =
  | { kind: 'owner_left' }
  | { kind: 'skipped'; reason: RefusalReason | SkipReason }
  | { kind: 'normal' };

/**
 * What a workflow or trigger row shows beside its last run: owner-left (D-OW-36: disabled until
 * an Owner or Admin reassigns or deletes it), skipped with why (SPEND-6), or its plain status.
 */
export function automationRunState(input: { ownerLeftAt: string | Date | null | undefined; lastRunStatus: string | null; lastRunError: string | null }): AutomationRunState {
  if (input.ownerLeftAt) return { kind: 'owner_left' };
  const reason = runSkipReason(input.lastRunError);
  return reason ? { kind: 'skipped', reason } : { kind: 'normal' };
}
