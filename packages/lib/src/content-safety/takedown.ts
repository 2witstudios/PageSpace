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

/**
 * What reading an object once tells us about its bytes.
 *
 * `sha256` is the hash of the bytes as stored; two objects with the same one
 * are byte-for-byte the same, which is how a copy is checked against its
 * source. `contentSha256` is the hash of the content those bytes hold: the same
 * as `sha256` for a plaintext object, and the hash of the decrypted bytes for
 * one encrypted at rest. A content hash names that content, so an object whose
 * `contentSha256` equals the case's hash IS the content, whoever wrote it.
 */
export interface ObjectDigest {
  size: number;
  sha256: string;
  contentSha256: string;
}

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
  /** Read an uploads-bucket object once and hash it. Null only on a definite not-found. */
  digestSource(key: string): Promise<ObjectDigest | null>;
  /** Read an evidence-bucket object once and hash it. Null only on a definite not-found. */
  digestEvidence(evidenceKey: string): Promise<ObjectDigest | null>;
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
  /**
   * Everything that references the hash. The AI-message part is a quick,
   * best-effort attempt here: results are kept, a failure sets `aiMessageScanFailed`.
   */
  collectReferences(contentHash: string): Promise<ContentReferences>;
  /** The AI-chat messages carrying the file and their authors, with a long timeout. Throws rather than return a partial list. */
  collectAiReferences(contentHash: string): Promise<AiMessageReferences>;
  /**
   * Run `fn` holding the case's run lock, or return `{ acquired: false }` at
   * once when another run holds it. One run of a case at a time: two runs that
   * each read the case and act on it can each act on a version the other has
   * already made stale. `signal` aborts if the lock is lost while `fn` runs.
   */
  withCaseLock<T>(caseId: string, fn: (signal?: AbortSignal) => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
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
  /** Set when another run of the case was already under way: this one did nothing. */
  inProgress?: true;
}

/** Where a case's preserved copy lives in the evidence bucket. Includes the case ID. */
export function evidenceKeyFor(caseId: string, contentHash: string): string {
  return `cases/${caseId}/${contentHash}/original`;
}

/**
 * Copy one object to the evidence bucket and prove the copy holds exactly the
 * bytes that were read from the source. Compared by checksum, never by size: a
 * copy of the same length with different bytes is not a copy. Throws if it is not.
 */
async function copyAndVerify(source: TakedownOriginal, expected: ObjectDigest, evidenceKey: string, deps: TakedownDeps): Promise<void> {
  await deps.storage.copyToEvidence(source, evidenceKey);
  const copy = await deps.storage.digestEvidence(evidenceKey);
  if (!copy) throw new Error('Evidence copy not found after copying');
  if (copy.sha256 !== expected.sha256) {
    throw new Error('Evidence copy checksum does not match the source; the source was left in place');
  }
}

/**
 * Preserve the hash's private original in the evidence bucket, or recognise a
 * copy already there.
 *
 * The case's content hash is the proof. The primary evidence key holds the
 * content the hash names, or it does not: an object there whose content hashes
 * to the case's hash IS the preserved copy, whether or not recording it on the
 * case got as far as succeeding. Nothing else is trusted, and a primary copy
 * that verifies is never overwritten.
 *
 * Bytes at the source that are NOT that content (a presigned PUT of something
 * else to a blocked key) are kept too, under a key named by their own checksum,
 * never at the primary key.
 */
async function preserve(row: ContentCase, contentHash: string, deps: TakedownDeps): Promise<{ detail?: string; skipped?: boolean }> {
  const primaryKey = evidenceKeyFor(row.id, contentHash);
  const snapshot = row.snapshot;
  const recordPrimary = async () => {
    if (snapshot?.evidenceKey !== primaryKey) await deps.cases.mergeSnapshot(row.id, { evidenceKey: primaryKey });
  };
  const primary = await deps.storage.digestEvidence(primaryKey);
  const primaryVerified = primary?.contentSha256 === contentHash;
  const source = await deps.storage.findOriginal(contentHash, row.id);

  if (!source) {
    if (primaryVerified) {
      await recordPrimary();
      return { detail: 'already_preserved' };
    }
    if (primary) throw new Error('An unverified evidence copy exists and there is no source left to verify it against');
    // The case says a copy was preserved, but it is not there. Stop: going on
    // would delete what is left with the evidence missing.
    if (snapshot?.evidenceKey) throw new Error('The preserved evidence copy recorded on this case is missing');
    return { detail: 'no_source_object', skipped: true };
  }

  const read = await deps.storage.digestSource(source.key);
  if (!read) throw new Error('The source object disappeared before it could be checked');

  if (read.contentSha256 === contentHash) {
    if (primaryVerified) {
      await recordPrimary();
      return { detail: 'already_preserved' };
    }
    // Nothing preserved yet, or only an object that is not the content: (re)write it.
    await copyAndVerify(source, read, primaryKey, deps);
    await recordPrimary();
    return { detail: `bytes=${read.size}` };
  }

  const additionalKey = `${primaryKey}.${read.sha256}`;
  const existing = await deps.storage.digestEvidence(additionalKey);
  if (existing?.sha256 !== read.sha256) await copyAndVerify(source, read, additionalKey, deps);
  const known = snapshot?.additionalEvidenceKeys ?? [];
  if (!known.includes(additionalKey)) {
    await deps.cases.mergeSnapshot(row.id, { additionalEvidenceKeys: [...known, additionalKey] });
  }
  return { detail: `additional_copy sha256=${read.sha256} bytes=${read.size}` };
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
    case 'preserve':
      return preserve(row, contentHash, deps);
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
        detail:
          `pages=${references.pageIds.length} files=${references.fileIds.length} drives=${references.driveIds.length} uploaders=${references.uploaderUserIds.length}` +
          // Not a failure: the mandatory search still runs before the case can finish.
          (references.aiMessageScanFailed ? ' ai_message_search=deferred' : ''),
      };
    }
    case 'record_ai_references': {
      const ai = await deps.cases.collectAiReferences(contentHash);
      // UNION with what the earlier step stored, never replace it: a message the
      // early attempt found may have been deleted since, and its author must stay
      // on the case. (`row` is read fresh before every step.)
      const stored = row.snapshot?.references;
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
      // The references the previous steps stored (`row` is read fresh before every step).
      const uploaders = (row.snapshot?.references?.uploaderUserIds ?? []).filter(
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

/** Run `fn` under the case's run lock; a second run while one holds it answers "in progress" and does nothing. */
async function exclusive(
  caseId: string,
  deps: CaseDeps,
  fn: (signal?: AbortSignal) => Promise<TakedownRunResult>,
): Promise<TakedownRunResult> {
  const locked = await deps.cases.withCaseLock(caseId, fn);
  if (locked.acquired) return locked.value;
  const row = await loadCase(caseId, deps);
  return { caseId, status: row.status, inProgress: true };
}

/** The case as a global takedown may run it, or a throw. Checked again on every reload. */
function requireGlobal(row: ContentCase): { category: ContentBlockCategory; contentHash: string } {
  if (row.snapshot?.takedown?.kind !== 'global') throw new Error(`Content case ${row.id} is not a global takedown`);
  if (!row.category || !allowsGlobalTakedown(row.category)) {
    throw new Error(`A ${row.category ?? 'uncategorised'} case cannot purge a hash globally; use a scoped takedown for policy`);
  }
  if (!row.contentHash) throw new Error(`Content case ${row.id} has no content hash`);
  return { category: row.category, contentHash: row.contentHash };
}

/**
 * Run (or continue) a global takedown. Safe to call any number of times on the
 * same case: it starts at the first step that has not succeeded and does
 * nothing at all on a finished one. One run at a time: while a run holds the
 * case, another answers `inProgress` and does nothing.
 */
export async function runGlobalTakedown(caseId: string, deps: TakedownDeps): Promise<TakedownRunResult> {
  return exclusive(caseId, deps, (signal) => runGlobalTakedownLocked(caseId, deps, signal));
}

/** Thrown before a step when the run lock was lost: another run may now hold the case, so this one stops. */
function assertLockHeld(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('The run lock on this case was lost; the step was not started. Run the case again.');
}

async function runGlobalTakedownLocked(caseId: string, deps: TakedownDeps, signal?: AbortSignal): Promise<TakedownRunResult> {
  for (;;) {
    // The case is read again before EVERY step. It can be re-filed while this
    // run is under way (the re-file does not wait for the run): a new category,
    // a withdrawn "skip preservation". Whether preservation may be skipped, and
    // whether a delete may go ahead, is decided on what the case says now, not
    // on what it said when the run began.
    const row = await loadCase(caseId, deps);
    const { category, contentHash } = requireGlobal(row);
    const takedown = row.snapshot?.takedown;
    const decision = nextGlobalTakedownStep({
      steps: row.steps ?? [],
      category,
      evidenceConfigured: deps.storage.evidenceConfigured(),
      skipPreservation: takedown?.skipPreservation === true,
      suspendUploader: takedown?.suspendUploader === true,
    });

    if (decision.kind === 'done' || decision.kind === 'halt') {
      const status = statusForDecision(decision);
      await settle(row, status, deps);
      return decision.kind === 'halt' ? { caseId, status, haltReason: decision.reason } : { caseId, status };
    }

    if (decision.kind === 'skip') {
      await deps.cases.appendStep(caseId, stepEntry(decision.step, 'skipped', decision.detail, deps));
      continue;
    }

    try {
      assertLockHeld(signal);
      const outcome = await executeGlobalStep(decision.step, row, contentHash, deps);
      await deps.cases.appendStep(caseId, stepEntry(decision.step, outcome.skipped ? 'skipped' : 'ok', outcome.detail, deps));
    } catch (error) {
      const message = errorMessage(error);
      await deps.cases.appendStep(caseId, stepEntry(decision.step, 'failed', message, deps));
      await settle(row, 'open', deps);
      return { caseId, status: 'open', failedStep: decision.step, error: message };
    }
  }
}

/**
 * Pass over storage again for a finished global takedown: take public copies
 * down, preserve whatever is there now and delete it. For bytes that reached a
 * blocked key after the first pass through a presigned PUT issued before the
 * block, or a public copy written by a publish already in flight.
 *
 * A pass that fails leaves the case `open` with its marker in place; calling
 * this again continues that pass rather than starting another. Every failure
 * alerts, and the attempt count on the case is what lets the cron retry a
 * bounded number of times (`MAX_RESWEEP_ATTEMPTS`). Holds the case's run lock
 * for the whole pass, the bookkeeping included.
 */
export async function resweepGlobalTakedown(caseId: string, deps: TakedownDeps): Promise<TakedownRunResult> {
  return exclusive(caseId, deps, async (signal) => {
    const row = await loadCase(caseId, deps);
    const attempts = (row.snapshot?.resweep?.attempts ?? 0) + 1;
    if (row.status === 'actioned') {
      await deps.cases.appendStep(caseId, stepEntry(RESWEEP_MARKER, 'ok', undefined, deps));
    }
    await deps.cases.mergeSnapshot(caseId, { resweep: { attempts, done: false } });

    const result = await runGlobalTakedownLocked(caseId, deps, signal);
    if (result.status === 'actioned') {
      await deps.cases.mergeSnapshot(caseId, { resweep: { attempts, done: true } });
    } else {
      await safeAlert(deps, { event: 'resweep_failed', caseId, category: row.category, attempt: attempts });
    }
    return result;
  });
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
  return exclusive(caseId, deps, () => runLinearCaseLocked(caseId, plan, deps));
}

async function runLinearCaseLocked(caseId: string, plan: readonly LinearStep[], deps: CaseDeps): Promise<TakedownRunResult> {
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
