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
import type { SuspendUserResult } from '../auth/suspend-user';
import { allowsGlobalTakedown } from './policy';
import type { AiMessageReferences } from './references';
import {
  RESWEEP_MARKER,
  latestEntry,
  nextGlobalTakedownStep,
  statusForDecision,
  type GlobalTakedownStep,
  type TakedownHaltReason,
} from './takedown-plan';

export type ContentReferences = NonNullable<ContentCaseSnapshot['references']>;

/** The object a preserved copy is made from. Always in the private uploads bucket. */
export interface TakedownOriginal {
  key: string;
  size: number;
}

/**
 * Where a public-only file is copied, inside the PRIVATE uploads bucket, before
 * its public key is deleted. It is the preserve step's source when no private
 * original exists, and is deleted with the rest of the hash's private objects.
 */
export function holdKeyFor(caseId: string, contentHash: string): string {
  return `content-hold/${caseId}/${contentHash}`;
}

export interface TakedownStorage {
  evidenceConfigured(): boolean;
  /**
   * The private original for the hash: `files/<hash>/original`, then
   * `chat-attachments/<hash>/original`, then this case's hold copy. Null only on
   * a definite not-found; any other error must throw, so "couldn't check" is
   * never read as "nothing to preserve".
   */
  findOriginal(contentHash: string, caseId: string): Promise<TakedownOriginal | null>;
  /**
   * Take the hash off the web now: delete `assets/<hash>` and
   * `assets/cache/<hash>/*` from the public bucket. If no private original
   * exists, the public asset is first copied to the case's hold key in the
   * private uploads bucket and the copy's size verified, so the delete never
   * destroys the only copy. `held` says whether that copy was made.
   */
  takePublicOffline(contentHash: string, caseId: string): Promise<{ deleted: number; held: boolean }>;
  headEvidence(evidenceKey: string): Promise<{ size: number } | null>;
  copyToEvidence(source: TakedownOriginal, evidenceKey: string): Promise<void>;
  /**
   * Delete `files/<hash>/*`, `cache/<hash>/*`, `chat-attachments/<hash>/*` and
   * the case's hold copy. Returns the number deleted.
   */
  deleteFromUploads(contentHash: string, caseId: string): Promise<number>;
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
  /** References held in rows: pages, files, drives, channel and direct messages. Fast; no AI-message scan. */
  collectReferences(contentHash: string): Promise<ContentReferences>;
  /** The AI-chat messages carrying the file and their authors. Slow; throws rather than return a partial list. */
  collectAiReferences(contentHash: string): Promise<AiMessageReferences>;
}

/** `skipped_admin`: the account is an admin, and a takedown never suspends one automatically. */
export type SuspendUserOutcome = SuspendUserResult | { status: 'skipped_admin' };

/**
 * The most accounts one takedown will suspend on its own. Storage is shared by
 * hash, so a widely held file (a common malware sample, a false positive) can
 * have many uploaders; past this number the takedown suspends nobody and leaves
 * the decision to a person, who has the list on the case.
 */
export const MAX_AUTO_SUSPENSIONS = 5;

export interface TakedownAlert {
  event: 'opened' | 'actioned' | 'awaiting_evidence' | 'resweep_failed';
  caseId: string;
  category: ContentBlockCategory | null;
  /** `resweep_failed`: which attempt this was, out of `MAX_RESWEEP_ATTEMPTS`. */
  attempt?: number;
}

/** How many times the cron passes over a finished takedown's storage before leaving it to a person. */
export const MAX_RESWEEP_ATTEMPTS = 3;

export interface TakedownDeps {
  cases: TakedownCaseStore;
  storage: TakedownStorage;
  suspendUser(input: { userId: string; reason: string }): Promise<SuspendUserOutcome>;
  /** Best-effort: a failed alert is swallowed here and never fails a takedown. */
  alert(alert: TakedownAlert): Promise<void>;
  now?: () => Date;
}

/** What recording a case needs: the store, alerting and the clock. No storage. */
type CaseDeps = Pick<TakedownDeps, 'cases' | 'alert' | 'now'>;

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

/** Copy one object to the evidence bucket and prove the copy is whole. Throws if it is not. */
async function copyAndVerify(source: TakedownOriginal, evidenceKey: string, deps: TakedownDeps): Promise<number> {
  await deps.storage.copyToEvidence(source, evidenceKey);
  const copy = await deps.storage.headEvidence(evidenceKey);
  if (!copy) throw new Error('Evidence copy not found after copying');
  if (copy.size !== source.size) {
    throw new Error(`Evidence copy size ${copy.size} does not match source size ${source.size}`);
  }
  return copy.size;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function loadCase(caseId: string, deps: CaseDeps): Promise<ContentCase> {
  const row = await deps.cases.load(caseId);
  if (!row) throw new Error(`Content case ${caseId} not found`);
  return row;
}

/** Send an alert, best-effort: an unsent email must not undo or fail a takedown; the case row is the record. */
export async function safeAlert(deps: Pick<TakedownDeps, 'alert'>, alert: TakedownAlert): Promise<void> {
  try {
    await deps.alert(alert);
  } catch {
    // Swallowed by design; the alert sender logs its own failure.
  }
}

/** Set the status and, only when it actually changed, send the matching alert. */
async function settle(row: ContentCase, status: ContentCaseStatus, deps: CaseDeps): Promise<void> {
  if (row.status === status) return;
  await deps.cases.setStatus(row.id, status);
  if (status === 'actioned' || status === 'awaiting_evidence') {
    await safeAlert(deps, { event: status, caseId: row.id, category: row.category });
  }
}

function stepEntry(step: string, status: ContentCaseStep['status'], detail: string | undefined, deps: CaseDeps): ContentCaseStep {
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
    case 'unpublish_public': {
      const { deleted, held } = await deps.storage.takePublicOffline(contentHash, row.id);
      return { detail: `deleted=${deleted}${held ? ' held_private_copy' : ''}` };
    }
    case 'preserve': {
      const evidenceKey = evidenceKeyFor(row.id, contentHash);
      // The key is written to the snapshot only after a copy passed verification,
      // so its presence there is what "verified" means.
      const snapshot = (await loadCase(row.id, deps)).snapshot;
      const verified = snapshot?.evidenceKey === evidenceKey;
      const existing = await deps.storage.headEvidence(evidenceKey);
      const source = await deps.storage.findOriginal(contentHash, row.id);

      if (!source) {
        if (existing && verified) return { detail: 'already_preserved' };
        if (existing) throw new Error('An unverified evidence copy exists and there is no source left to verify it against');
        // The case says a copy was preserved, but it is not there. Stop: going on
        // would delete what is left with the evidence missing.
        if (verified) throw new Error('The preserved evidence copy recorded on this case is missing');
        return { detail: 'no_source_object', skipped: true };
      }
      if (!existing || !verified) {
        // Nothing preserved yet, or only a copy that never passed verification: (re)write it.
        const bytes = await copyAndVerify(source, evidenceKey, deps);
        await deps.cases.mergeSnapshot(row.id, { evidenceKey });
        return { detail: `bytes=${bytes}` };
      }
      if (existing.size === source.size) return { detail: 'already_preserved' };

      // A VERIFIED copy is never overwritten. Different bytes have since landed at
      // the source key (a re-sweep after an old presigned PUT): they are preserved
      // beside the first copy, under their own key, and both stay on the case.
      const additionalKey = `${evidenceKey}.${source.size}`;
      const additional = await deps.storage.headEvidence(additionalKey);
      if (!additional || additional.size !== source.size) await copyAndVerify(source, additionalKey, deps);
      const known = snapshot?.additionalEvidenceKeys ?? [];
      if (!known.includes(additionalKey)) {
        await deps.cases.mergeSnapshot(row.id, { additionalEvidenceKeys: [...known, additionalKey] });
      }
      return { detail: `additional_copy bytes=${source.size}` };
    }
    case 'delete_uploads':
      return { detail: `deleted=${await deps.storage.deleteFromUploads(contentHash, row.id)}` };
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
    case 'record_ai_references': {
      const ai = await deps.cases.collectAiReferences(contentHash);
      // Merge into what the earlier step stored; a resumed run has nothing in memory.
      const stored = (await loadCase(row.id, deps)).snapshot?.references;
      const union = (a: readonly string[] = [], b: readonly string[]) => [...new Set([...a, ...b])];
      const references: ContentReferences = {
        pageIds: stored?.pageIds ?? [],
        fileIds: stored?.fileIds ?? [],
        driveIds: stored?.driveIds ?? [],
        channelMessageIds: stored?.channelMessageIds ?? [],
        directMessageIds: stored?.directMessageIds ?? [],
        uploaderUserIds: union(stored?.uploaderUserIds, ai.uploaderUserIds),
        aiMessageIds: union(stored?.aiMessageIds, ai.aiMessageIds),
        conversationIds: union(stored?.conversationIds, ai.conversationIds),
        truncated: (stored?.truncated ?? false) || ai.truncated,
      };
      await deps.cases.mergeSnapshot(row.id, { references, uploaderUserId: references.uploaderUserIds[0] });
      return { detail: `ai_messages=${ai.aiMessageIds.length} uploaders=${ai.uploaderUserIds.length}` };
    }
    case 'suspend_uploader': {
      // Read the references the previous step stored, not the ones in memory:
      // a resumed run starts here with none.
      const fresh = await loadCase(row.id, deps);
      const uploaders = (fresh.snapshot?.references?.uploaderUserIds ?? []).filter(
        (userId) => userId !== takedown?.actorUserId,
      );
      if (uploaders.length === 0) return { detail: 'no_uploader_found', skipped: true };
      if (uploaders.length > MAX_AUTO_SUSPENSIONS) {
        return {
          detail: `too_many_uploaders=${uploaders.length} max=${MAX_AUTO_SUSPENSIONS}; nobody was suspended, review the list on the case`,
          skipped: true,
        };
      }
      const outcomes: string[] = [];
      for (const userId of uploaders) {
        const outcome = await deps.suspendUser({ userId, reason: `Content takedown, case ${row.id}` });
        outcomes.push(`${userId}:${outcome.status}`);
      }
      return { detail: outcomes.join(' ') };
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
 * Pass over storage again for a finished global takedown: preserve whatever is
 * there now and delete it. For bytes that reached a blocked key after the first
 * pass through a presigned PUT issued before the block.
 *
 * A pass that fails leaves the case `open` with its marker in place; calling
 * this again continues that pass rather than starting another. Every failure
 * alerts, and the attempt count on the case is what lets the cron retry a
 * bounded number of times (`MAX_RESWEEP_ATTEMPTS`).
 */
export async function resweepGlobalTakedown(caseId: string, deps: TakedownDeps): Promise<TakedownRunResult> {
  const row = await loadCase(caseId, deps);
  const attempts = (row.snapshot?.resweep?.attempts ?? 0) + 1;
  if (row.status === 'actioned') {
    await deps.cases.appendStep(caseId, stepEntry(RESWEEP_MARKER, 'ok', undefined, deps));
  }
  await deps.cases.mergeSnapshot(caseId, { resweep: { attempts, done: false } });

  const result = await runGlobalTakedown(caseId, deps);
  if (result.status === 'actioned') {
    await deps.cases.mergeSnapshot(caseId, { resweep: { attempts, done: true } });
  } else {
    await safeAlert(deps, { event: 'resweep_failed', caseId, category: row.category, attempt: attempts });
  }
  return result;
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
export async function runLinearCase(caseId: string, plan: readonly LinearStep[], deps: CaseDeps): Promise<TakedownRunResult> {
  const row = await loadCase(caseId, deps);
  const steps = row.steps ?? [];

  for (const { step, run } of plan) {
    const latest = latestEntry(steps, step);
    if (latest && latest.status !== 'failed') continue;
    try {
      const detail = (await run()) ?? undefined;
      await deps.cases.appendStep(caseId, stepEntry(step, 'ok', detail, deps));
    } catch (error) {
      const message = errorMessage(error);
      await deps.cases.appendStep(caseId, stepEntry(step, 'failed', message, deps));
      await settle(row, 'open', deps);
      return { caseId, status: 'open', failedStep: step, error: message };
    }
  }

  await settle(row, 'actioned', deps);
  return { caseId, status: 'actioned' };
}
