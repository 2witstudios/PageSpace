/**
 * Global takedown — the pure planner. State in, next step out, no I/O.
 *
 * A takedown is a fixed sequence of steps. Each attempt is appended to
 * `content_cases.steps`, and the LATEST entry for a step is its state, so a
 * rerun on the same case continues at the first step that has not succeeded.
 * Every executor is idempotent, which is what makes rerunning safe.
 *
 * The order is the safety property:
 *   1. block       — the gates close before anything else happens.
 *   2. record      — who and what referenced the hash, written to the case
 *                    NOW. A case can wait at preservation for a long time, and
 *                    the uploader can delete their page meanwhile; the rows
 *                    that say who uploaded it must be captured before then.
 *   3. unpublish   — public copies come off the web at once, so the content is
 *                    not served to the world even if the case then has to wait
 *                    at the next step. Nothing is lost: the private original
 *                    is untouched, and a public-only file is first copied into
 *                    private storage.
 *   4. preserve    — nothing is deleted until a copy is verified (or, outside
 *                    CSAM, an admin has explicitly declined one).
 *   5. deletes     — uploads bucket, then the public bucket.
 *   6. suspend     — only when asked for, from the uploaders recorded in step 2.
 */

import type {
  ContentBlockCategory,
  ContentCase,
  ContentCaseStatus,
  ContentCaseStep,
  ContentTakedownKind,
} from '@pagespace/db/schema/content-safety';

export const GLOBAL_TAKEDOWN_STEPS = [
  'block',
  'record_references',
  'unpublish_public',
  'preserve',
  'delete_uploads',
  'delete_public',
  'suspend_uploader',
] as const;

export type GlobalTakedownStep = (typeof GLOBAL_TAKEDOWN_STEPS)[number];

/**
 * Appended to the step log to ask for another pass over storage. A presigned
 * PUT issued before the block stays valid for its TTL, so bytes can land at a
 * blocked key AFTER the delete ran; a re-sweep preserves and deletes again.
 */
export const RESWEEP_MARKER = 'resweep';

/** The steps a re-sweep repeats. Blocking, recording and suspending are not storage passes. */
const RESWEEP_STEPS: ReadonlySet<GlobalTakedownStep> = new Set(['preserve', 'delete_uploads', 'delete_public']);

export interface GlobalTakedownPlanInput {
  steps: readonly ContentCaseStep[];
  category: ContentBlockCategory;
  /** Whether an evidence bucket is configured in this deployment. */
  evidenceConfigured: boolean;
  /** Admin opted out of preservation. Ignored for CSAM. */
  skipPreservation: boolean;
  suspendUploader: boolean;
}

export type TakedownHaltReason =
  /** CSAM with nowhere to preserve it: blocked, nothing deleted. */
  | 'awaiting_evidence'
  /** Not CSAM, no evidence storage, and the admin has not said to skip preservation. */
  | 'preservation_decision_required';

export type TakedownDecision =
  | { kind: 'run'; step: GlobalTakedownStep }
  | { kind: 'skip'; step: GlobalTakedownStep; detail: string }
  | { kind: 'halt'; reason: TakedownHaltReason }
  | { kind: 'done' };

export function latestEntry(steps: readonly ContentCaseStep[], step: string): ContentCaseStep | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].step === step) return steps[i];
  }
  return undefined;
}

/** The detail recorded when an admin's "skip preservation" is honoured. */
export const SKIPPED_BY_ADMIN = 'skipped_by_admin';

/**
 * What the CURRENT category and options say about preservation, whatever the
 * case did before. CSAM is never deleted without a preserved copy, whatever the
 * admin asked for.
 */
function preservationRule(input: GlobalTakedownPlanInput): TakedownDecision {
  if (input.category === 'csam') {
    return input.evidenceConfigured ? { kind: 'run', step: 'preserve' } : { kind: 'halt', reason: 'awaiting_evidence' };
  }
  if (input.skipPreservation) return { kind: 'skip', step: 'preserve', detail: SKIPPED_BY_ADMIN };
  return input.evidenceConfigured
    ? { kind: 'run', step: 'preserve' }
    : { kind: 'halt', reason: 'preservation_decision_required' };
}

/**
 * A step is settled when its latest attempt succeeded or was deliberately
 * skipped — AND that outcome is still allowed under the case's current
 * category. A case can be re-filed under a different category (malware, then
 * CSAM); every settled step is judged against the new rules, not the ones it
 * ran under. Today one outcome depends on the category: an admin's skipped
 * preservation, which is void the moment the rule no longer permits a skip.
 */
function isSettled(step: GlobalTakedownStep, input: GlobalTakedownPlanInput): boolean {
  const { steps } = input;
  const scope = RESWEEP_STEPS.has(step)
    ? steps.slice(steps.map((entry) => entry.step).lastIndexOf(RESWEEP_MARKER) + 1)
    : steps;
  const latest = latestEntry(scope, step);
  if (latest === undefined || latest.status === 'failed') return false;
  if (step === 'preserve' && latest.status === 'skipped' && latest.detail === SKIPPED_BY_ADMIN) {
    return preservationRule(input).kind === 'skip';
  }
  return true;
}

export function nextGlobalTakedownStep(input: GlobalTakedownPlanInput): TakedownDecision {
  for (const step of GLOBAL_TAKEDOWN_STEPS) {
    if (step === 'suspend_uploader' && !input.suspendUploader) continue;
    if (isSettled(step, input)) continue;
    return step === 'preserve' ? preservationRule(input) : { kind: 'run', step };
  }
  return { kind: 'done' };
}

/** The case status a run leaves behind when it stops at this decision. */
export function statusForDecision(decision: TakedownDecision): ContentCaseStatus {
  if (decision.kind === 'done') return 'actioned';
  if (decision.kind === 'halt' && decision.reason === 'awaiting_evidence') return 'awaiting_evidence';
  return 'open';
}

export interface StepSummary {
  step: string;
  status: ContentCaseStep['status'] | 'pending';
  detail?: string;
}

/** The latest state of each planned step, in plan order. For case lists and progress display. */
export function summarizeSteps(steps: readonly ContentCaseStep[], plan: readonly string[]): StepSummary[] {
  return plan.map((step) => {
    const latest = latestEntry(steps, step);
    if (!latest) return { step, status: 'pending' };
    return latest.detail && latest.status === 'failed'
      ? { step, status: latest.status, detail: latest.detail }
      : { step, status: latest.status };
  });
}

/** The steps of the takedowns that have no branching. The global plan is `GLOBAL_TAKEDOWN_STEPS`. */
export const LINEAR_TAKEDOWN_STEPS = {
  unpublish_page: ['unpublish'],
  park_drive: ['park_sites'],
  avatar: ['delete_avatar', 'clear_profile_image'],
  park_user_sites: ['park_sites'],
} as const satisfies Record<Exclude<ContentTakedownKind, 'global'>, readonly string[]>;

export interface CaseProgress {
  /** Null for a case that is only a report, with no takedown attached. */
  kind: ContentTakedownKind | null;
  steps: StepSummary[];
  /** True when running the case again would do something: it has a takedown and has not finished. */
  resumable: boolean;
  /** True for a finished global takedown, or one whose last re-sweep failed, which can be passed over storage again. */
  resweepable: boolean;
  /** True for a drive-parking case whose hold is still in place and can be lifted. */
  restorable: boolean;
}

/** Recorded on a drive-parking case when its hold is lifted. */
export const RESTORE_SITES_STEP = 'restore_sites';

/** What a case list shows for one case: which takedown it is and how far it got. */
export function describeCaseProgress(row: Pick<ContentCase, 'status' | 'steps' | 'snapshot'>): CaseProgress {
  const takedown = row.snapshot?.takedown;
  const kind = takedown?.kind ?? null;
  if (!kind) return { kind: null, steps: [], resumable: false, resweepable: false, restorable: false };

  const recorded = row.steps ?? [];
  const restored = latestEntry(recorded, RESTORE_SITES_STEP)?.status === 'ok';
  const plan: string[] =
    kind === 'global'
      ? GLOBAL_TAKEDOWN_STEPS.filter((step) => step !== 'suspend_uploader' || takedown?.suspendUploader === true)
      : [...LINEAR_TAKEDOWN_STEPS[kind]];
  if (latestEntry(recorded, RESTORE_SITES_STEP)) plan.push(RESTORE_SITES_STEP);
  const failedResweep = row.status === 'open' && (row.snapshot?.resweep?.attempts ?? 0) > 0;
  return {
    kind,
    steps: summarizeSteps(recorded, plan),
    resumable: row.status === 'open' || row.status === 'awaiting_evidence',
    resweepable: kind === 'global' && (row.status === 'actioned' || failedResweep),
    restorable: kind === 'park_drive' && row.status === 'actioned' && !restored,
  };
}
