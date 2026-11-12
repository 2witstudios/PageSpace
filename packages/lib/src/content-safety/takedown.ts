/**
 * Takedown — the executor around the pure planner (takedown-plan.ts).
 *
 * Everything that touches the outside world comes in through `TakedownDeps`:
 * the case store (database), the object stores (uploads, public and evidence
 * buckets), suspension and alerting. The web app supplies the real ones; tests
 * supply in-memory ones, which is how resume-after-failure is tested without S3.
 *
 * Each step is idempotent and its outcome is appended to the case before the
 * next one starts, so a crash or failure at any point is continued by running
 * the same case again.
 */

import type {
  ContentBlockCategory,
  ContentBlockSource,
  ContentCase,
  ContentCaseSnapshot,
  ContentCaseStatus,
  ContentCaseStep,
} from '@pagespace/db/schema/content-safety';
import { allowsGlobalTakedown } from './policy';
import {
  RESWEEP_MARKER,
  latestEntry,
  nextGlobalTakedownStep,
  statusForDecision,
  type GlobalTakedownStep,
  type TakedownHaltReason,
} from './takedown-plan';

export type ContentReferences = NonNullable<ContentCaseSnapshot['references']>;

/** The object a preserved copy is made from. */
export interface TakedownOriginal {
  store: 'uploads' | 'publish';
  key: string;
  size: number;
}

export interface TakedownStorage {
  evidenceConfigured(): boolean;
  /**
   * The first original that exists for the hash: `files/<hash>/original`, then
   * `chat-attachments/<hash>/original`, then the public `assets/<hash>`. Null
   * only on a definite not-found; any other error must throw, so "couldn't
   * check" is never read as "nothing to preserve".
   */
  findOriginal(contentHash: string): Promise<TakedownOriginal | null>;
  /** Whether any object at all (original or derived, either bucket) exists for the hash. */
  hasAnyObjects(contentHash: string): Promise<boolean>;
  headEvidence(evidenceKey: string): Promise<{ size: number } | null>;
  copyToEvidence(source: TakedownOriginal, evidenceKey: string): Promise<void>;
  /** Delete `files/<hash>/*`, `cache/<hash>/*`, `chat-attachments/<hash>/*`. Returns the number deleted. */
  deleteFromUploads(contentHash: string): Promise<number>;
  /** Delete `assets/<hash>` and `assets/cache/<hash>/*`. Returns the number deleted. */
  deleteFromPublish(contentHash: string): Promise<number>;
}

export interface TakedownCaseStore {
  load(caseId: string): Promise<ContentCase | null>;
  appendStep(caseId: string, step: ContentCaseStep): Promise<void>;
  setStatus(caseId: string, status: ContentCaseStatus): Promise<void>;
  mergeSnapshot(caseId: string, patch: Partial<ContentCaseSnapshot>): Promise<void>;
  upsertBlock(block: {
    contentHash: string;
    category: ContentBlockCategory;
    source: ContentBlockSource;
    caseId: string;
    createdBy: string | null;
  }): Promise<void>;
  collectReferences(contentHash: string): Promise<ContentReferences>;
}

export type SuspendUserOutcome =
  | { status: 'suspended'; revokedSessions: number }
  | { status: 'already_suspended' }
  | { status: 'not_found' };

export interface TakedownAlert {
  event: 'opened' | 'actioned' | 'awaiting_evidence';
  caseId: string;
  category: ContentBlockCategory | null;
}

export interface TakedownDeps {
  cases: TakedownCaseStore;
  storage: TakedownStorage;
  suspendUser(input: { userId: string; reason: string }): Promise<SuspendUserOutcome>;
  /** Best-effort: a failed alert is swallowed here and never fails a takedown. */
  alert(alert: TakedownAlert): Promise<void>;
  now?: () => Date;
}

export interface TakedownRunResult {
  caseId: string;
  status: ContentCaseStatus;
  /** Set when the run stopped because a step threw. */
  failedStep?: string;
  error?: string;
  /** Set when the run stopped by design rather than by failure. */
  haltReason?: TakedownHaltReason;
}

/** Where a case's preserved copy lives in the evidence bucket. Includes the case ID. */
export function evidenceKeyFor(caseId: string, contentHash: string): string {
  return `cases/${caseId}/${contentHash}/original`;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function loadCase(caseId: string, deps: TakedownDeps): Promise<ContentCase> {
  const row = await deps.cases.load(caseId);
  if (!row) throw new Error(`Content case ${caseId} not found`);
  return row;
}

async function safeAlert(deps: TakedownDeps, alert: TakedownAlert): Promise<void> {
  try {
    await deps.alert(alert);
  } catch {
    // An unsent email must not undo or fail a takedown; the case row is the record.
  }
}

/** Set the status and, only when it actually changed, send the matching alert. */
async function settle(
  row: ContentCase,
  status: ContentCaseStatus,
  deps: TakedownDeps,
): Promise<void> {
  if (row.status === status) return;
  await deps.cases.setStatus(row.id, status);
  if (status === 'actioned' || status === 'awaiting_evidence') {
    await safeAlert(deps, { event: status, caseId: row.id, category: row.category });
  }
}

function stepEntry(step: string, status: ContentCaseStep['status'], detail: string | undefined, deps: TakedownDeps): ContentCaseStep {
  const at = (deps.now?.() ?? new Date()).toISOString();
  return detail ? { step, status, detail, at } : { step, status, at };
}

/** One global step. Returns `skipped: true` when there was nothing for it to do by design. */
async function executeGlobalStep(
  step: GlobalTakedownStep,
  row: ContentCase,
  contentHash: string,
  deps: TakedownDeps,
): Promise<{ detail?: string; skipped?: boolean }> {
  const takedown = row.snapshot?.takedown;
  switch (step) {
    case 'block': {
      await deps.cases.upsertBlock({
        contentHash,
        category: row.category as ContentBlockCategory,
        source: takedown?.actorUserId ? 'admin' : 'hash_match',
        caseId: row.id,
        createdBy: takedown?.actorUserId ?? null,
      });
      return {};
    }
    case 'preserve': {
      const evidenceKey = evidenceKeyFor(row.id, contentHash);
      if (await deps.storage.headEvidence(evidenceKey)) {
        await deps.cases.mergeSnapshot(row.id, { evidenceKey });
        return { detail: 'already_preserved' };
      }
      const source = await deps.storage.findOriginal(contentHash);
      if (!source) {
        // Derived objects (thumbnails, previews) of the same material may still
        // exist. Deleting them with nothing preserved is exactly what must not
        // happen for CSAM, so stop and leave them for a person to decide.
        if (row.category === 'csam' && (await deps.storage.hasAnyObjects(contentHash))) {
          throw new Error('No original left to preserve, but derived objects exist; nothing was deleted');
        }
        return { detail: 'no_source_object', skipped: true };
      }
      await deps.storage.copyToEvidence(source, evidenceKey);
      const copy = await deps.storage.headEvidence(evidenceKey);
      if (!copy) throw new Error('Evidence copy not found after copying');
      if (copy.size !== source.size) {
        throw new Error(`Evidence copy size ${copy.size} does not match source size ${source.size}`);
      }
      await deps.cases.mergeSnapshot(row.id, { evidenceKey });
      return { detail: `source=${source.store} bytes=${copy.size}` };
    }
    case 'delete_uploads':
      return { detail: `deleted=${await deps.storage.deleteFromUploads(contentHash)}` };
    case 'delete_public':
      return { detail: `deleted=${await deps.storage.deleteFromPublish(contentHash)}` };
    case 'record_references': {
      const references = await deps.cases.collectReferences(contentHash);
      await deps.cases.mergeSnapshot(row.id, {
        references,
        uploaderUserId: references.uploaderUserIds[0],
        driveIds: references.driveIds,
        pageIds: references.pageIds,
      });
      return {
        detail: `pages=${references.pageIds.length} files=${references.fileIds.length} drives=${references.driveIds.length} uploaders=${references.uploaderUserIds.length}`,
      };
    }
    case 'suspend_uploader': {
      // Read the references the previous step stored, not the ones in memory:
      // a resumed run starts here with none.
      const fresh = await loadCase(row.id, deps);
      const uploaders = (fresh.snapshot?.references?.uploaderUserIds ?? []).filter(
        (userId) => userId !== takedown?.actorUserId,
      );
      const outcomes: string[] = [];
      for (const userId of uploaders) {
        const outcome = await deps.suspendUser({ userId, reason: `Content takedown, case ${row.id}` });
        outcomes.push(`${userId}:${outcome.status}`);
      }
      return { detail: outcomes.length > 0 ? outcomes.join(' ') : 'no_uploader_found' };
    }
  }
}

/**
 * Run (or continue) a global takedown. Safe to call any number of times on the
 * same case: it starts at the first step that has not succeeded and does
 * nothing at all on a finished one.
 */
export async function runGlobalTakedown(caseId: string, deps: TakedownDeps): Promise<TakedownRunResult> {
  const row = await loadCase(caseId, deps);
  const takedown = row.snapshot?.takedown;
  if (takedown?.kind !== 'global') throw new Error(`Content case ${caseId} is not a global takedown`);
  if (!row.category || !allowsGlobalTakedown(row.category)) {
    throw new Error(`A ${row.category ?? 'uncategorised'} case cannot purge a hash globally; use a scoped takedown for policy`);
  }
  const contentHash = row.contentHash;
  if (!contentHash) throw new Error(`Content case ${caseId} has no content hash`);

  const steps: ContentCaseStep[] = [...(row.steps ?? [])];
  const record = async (entry: ContentCaseStep) => {
    await deps.cases.appendStep(caseId, entry);
    steps.push(entry);
  };

  for (;;) {
    const decision = nextGlobalTakedownStep({
      steps,
      category: row.category,
      evidenceConfigured: deps.storage.evidenceConfigured(),
      skipPreservation: takedown.skipPreservation === true,
      suspendUploader: takedown.suspendUploader === true,
    });

    if (decision.kind === 'done' || decision.kind === 'halt') {
      const status = statusForDecision(decision);
      await settle(row, status, deps);
      return decision.kind === 'halt' ? { caseId, status, haltReason: decision.reason } : { caseId, status };
    }

    if (decision.kind === 'skip') {
      await record(stepEntry(decision.step, 'skipped', decision.detail, deps));
      continue;
    }

    try {
      const outcome = await executeGlobalStep(decision.step, row, contentHash, deps);
      await record(stepEntry(decision.step, outcome.skipped ? 'skipped' : 'ok', outcome.detail, deps));
    } catch (error) {
      const message = errorMessage(error);
      await record(stepEntry(decision.step, 'failed', message, deps));
      await settle(row, 'open', deps);
      return { caseId, status: 'open', failedStep: decision.step, error: message };
    }
  }
}

/**
 * Pass over storage again for a finished global takedown: preserve (if nothing
 * was preserved yet) and delete. For bytes that reached a blocked key after the
 * first pass through a presigned PUT issued before the block.
 */
export async function resweepGlobalTakedown(caseId: string, deps: TakedownDeps): Promise<TakedownRunResult> {
  await deps.cases.appendStep(caseId, stepEntry(RESWEEP_MARKER, 'ok', undefined, deps));
  return runGlobalTakedown(caseId, deps);
}

export interface LinearStep {
  step: string;
  /** Returns an optional detail string for the case record. Must be idempotent. */
  run(): Promise<string | undefined | void>;
}

/**
 * Run a fixed list of steps against a case with the same record-and-resume
 * rules as the global takedown. Used by the scoped, avatar and site-parking
 * takedowns, whose plans have no branching.
 */
export async function runLinearCase(
  caseId: string,
  plan: readonly LinearStep[],
  deps: Pick<TakedownDeps, 'cases' | 'alert' | 'now'>,
): Promise<TakedownRunResult> {
  const fullDeps = deps as TakedownDeps;
  const row = await loadCase(caseId, fullDeps);
  const steps = row.steps ?? [];

  for (const { step, run } of plan) {
    const latest = latestEntry(steps, step);
    if (latest && latest.status !== 'failed') continue;
    try {
      const detail = (await run()) ?? undefined;
      await deps.cases.appendStep(caseId, stepEntry(step, 'ok', detail, fullDeps));
    } catch (error) {
      const message = errorMessage(error);
      await deps.cases.appendStep(caseId, stepEntry(step, 'failed', message, fullDeps));
      await settle(row, 'open', fullDeps);
      return { caseId, status: 'open', failedStep: step, error: message };
    }
  }

  await settle(row, 'actioned', fullDeps);
  return { caseId, status: 'actioned' };
}
