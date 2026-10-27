/**
 * Core logic for the mislabelled-`contentMode` backfill
 * (`apps/web/scripts/backfill-mislabelled-content-mode.ts`). Pure/imperative
 * shell split out of the CLI script so it lives under `src/**` and is
 * exercised by `apps/web`'s ordinary vitest config — the script file itself
 * is a thin argv/stdout wrapper, same split as `collab-content-census.ts`
 * vs. `src/lib/editor/census/`.
 *
 * See the script's own header for the full rationale (why relabel rather
 * than convert, why this is reversible, why dry-run is the default).
 */
import { and, asc, eq, gt, or, sql } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import type { getMigrationDb } from '@pagespace/db/db';
import { createDomWorkspace, classifyDocumentContent } from './document-content-format';

/**
 * Run thunks one at a time. See the call site for why this is sequential:
 * these scripts hold a one-connection pool by design, so any concurrency here
 * deadlocks rather than speeds anything up.
 */
async function sequentially(tasks: Array<() => Promise<void>>): Promise<void> {
  for (const task of tasks) {
    await task();
  }
}


export type BackfillDb = ReturnType<typeof getMigrationDb>;

const DEFAULT_BATCH_SIZE = 200;

/**
 * A corrected page, as recorded in the `--out` manifest. `revisionAfterApply`
 * is what makes `--revert` safe: `applyPageMutation` bumps `revision` on
 * every ordinary save, so a page a user edits after this backfill runs will
 * have moved past this value by the time anyone reverts — the revert compare-
 * and-swap requires an exact match and leaves that page alone rather than
 * discarding the user's edit.
 */
export interface CorrectedPage {
  id: string;
  revisionAfterApply: number;
}

export interface BackfillSummary {
  scanned: number;
  corrected: CorrectedPage[];
  skippedUnparseable: Array<{ id: string; reason: string }>;
  skippedConcurrentModification: string[];
}

export interface PlanAndApplyOptions {
  apply: boolean;
  batchSize?: number;
  /**
   * Invoked once per batch, after that batch's writes have committed, with
   * exactly the pages this batch corrected. The CLI wrapper uses this to
   * durably persist the `--out` manifest incrementally rather than only once
   * at the very end — without it, a process killed partway through a
   * multi-thousand-row run would leave already-corrected pages with no
   * record to revert them by. Never called in dry-run mode (nothing was
   * written) or for an empty batch.
   */
  onBatchCorrected?: (corrected: CorrectedPage[]) => Promise<void> | void;
}

/**
 * Scans every `contentMode='html'` DOCUMENT page (trashed included — a
 * restored page is seeded like any other, so its label matters just as
 * much), classifies its stored content by inspection, and either reports
 * (dry run) or corrects (`apply`) the ones holding markdown source.
 */
export async function planAndApplyBackfill(
  db: BackfillDb,
  { apply, batchSize = DEFAULT_BATCH_SIZE, onBatchCorrected }: PlanAndApplyOptions,
): Promise<BackfillSummary> {
  const workspace = createDomWorkspace();
  const summary: BackfillSummary = {
    scanned: 0,
    corrected: [],
    skippedUnparseable: [],
    skippedConcurrentModification: [],
  };

  try {
    let after: string | null = null;
    for (;;) {
      const batch = await db
        .select({
          id: pages.id,
          content: pages.content,
          contentMode: pages.contentMode,
          updatedAt: pages.updatedAt,
          revision: pages.revision,
        })
        .from(pages)
        .where(
          and(
            eq(pages.type, 'DOCUMENT'),
            eq(pages.contentMode, 'html'),
            after === null ? undefined : gt(pages.id, after),
          ),
        )
        .orderBy(asc(pages.id))
        .limit(batchSize);

      if (batch.length === 0) break;

      const mislabelled: (typeof batch)[number][] = [];
      for (const page of batch) {
        summary.scanned += 1;
        const classification = classifyDocumentContent(page.content, workspace);

        if (!classification.confident) {
          summary.skippedUnparseable.push({ id: page.id, reason: classification.reason });
        } else if (classification.format === 'markdown-source') {
          mislabelled.push(page);
        }
        // 'empty' or genuinely 'html' — correctly labelled, nothing to do.
      }

      if (!apply) {
        summary.corrected.push(...mislabelled.map((page) => ({ id: page.id, revisionAfterApply: page.revision + 1 })));
      } else if (mislabelled.length > 0) {
        // Written SEQUENTIALLY, and that is not a missed optimisation.
        //
        // This ran as `Promise.all` over the batch — up to `batchSize` (200)
        // writes in flight — until the first real run against production died
        // on `timeout exceeded when trying to connect` before it corrected a
        // single row. The scripts that call this use `getMigrationPool()`,
        // which is deliberately `max: 1` (packages/db/src/db.ts:117) so a
        // long-running backfill cannot starve the deployment it is running
        // against. Two hundred concurrent writes against a one-connection pool
        // is a self-deadlock: the first takes the connection, the other 199
        // wait for one that cannot free until they stop waiting.
        //
        // Do not "restore" the concurrency without also giving these scripts a
        // pool that can serve it — the concurrency was never the thing making
        // this fast, and the pool bound is the thing keeping production safe.
        const batchCorrected: CorrectedPage[] = [];
        await sequentially(
          mislabelled.map((page) => async () => {
            // Compare-and-swap on the exact content read: a page edited
            // between the select and this write must not be relabelled
            // against content this run never actually classified. updatedAt
            // is pinned to its prior value — this is a label correction, not
            // a user edit. `revision` is bumped (atomically, via the SQL
            // expression, not the stale JS-side value) so a client session
            // that already had this page open under the old `contentMode`
            // gets a 409 on its next save instead of silently writing content
            // that no longer matches the label — see PR #2511 review.
            const [written] = await db
              .update(pages)
              .set({ contentMode: 'markdown', updatedAt: page.updatedAt, revision: sql`${pages.revision} + 1` })
              .where(and(eq(pages.id, page.id), eq(pages.content, page.content), eq(pages.contentMode, 'html')))
              .returning({ id: pages.id, revision: pages.revision });

            if (!written) {
              summary.skippedConcurrentModification.push(page.id);
            } else {
              batchCorrected.push({ id: written.id, revisionAfterApply: written.revision });
            }
          }),
        );

        summary.corrected.push(...batchCorrected);
        if (batchCorrected.length > 0 && onBatchCorrected) {
          await onBatchCorrected(batchCorrected);
        }
      }

      after = batch[batch.length - 1].id;
    }
  } finally {
    workspace.close();
  }

  return summary;
}

export interface RevertSummary {
  attempted: number;
  reverted: string[];
  skippedAlreadyChanged: string[];
}

/**
 * Flips exactly the given pages back to `contentMode='html'` — only a page
 * still `contentMode='markdown'` **at the exact revision this backfill left
 * it at** is touched. A page edited since (by a real user save, which always
 * bumps `revision`) no longer matches and is reported as skipped rather than
 * forced, so a revert can never discard a genuine edit.
 */
export async function revertBackfill(db: BackfillDb, corrections: CorrectedPage[]): Promise<RevertSummary> {
  if (corrections.length === 0) {
    return { attempted: 0, reverted: [], skippedAlreadyChanged: [] };
  }

  // One batched UPDATE rather than one round trip per id: the per-row OR
  // branch pins EACH id to its own expected revision (a single inArray on ids
  // plus a separate inArray on revisions would cross-match any id against any
  // revision in the list, not the specific pairing this guard requires).
  // `RETURNING id` reports exactly which pages were still at that revision
  // and so actually flipped.
  const written = await db
    .update(pages)
    .set({ contentMode: 'html', revision: sql`${pages.revision} + 1` })
    .where(
      and(
        eq(pages.contentMode, 'markdown'),
        or(...corrections.map((c) => and(eq(pages.id, c.id), eq(pages.revision, c.revisionAfterApply)))),
      ),
    )
    .returning({ id: pages.id });

  const reverted = new Set(written.map((row) => row.id));
  return {
    attempted: corrections.length,
    reverted: corrections.map((c) => c.id).filter((id) => reverted.has(id)),
    skippedAlreadyChanged: corrections.map((c) => c.id).filter((id) => !reverted.has(id)),
  };
}

export interface BackfillArgs {
  mode: 'dry-run' | 'apply' | 'revert';
  outPath?: string;
  revertPath?: string;
}

export type ParseArgsResult = { ok: true; args: BackfillArgs } | { ok: false; error: string };

export function parseBackfillArgs(argv: string[]): ParseArgsResult {
  const apply = argv.includes('--apply');
  const revertIndex = argv.indexOf('--revert');
  const outIndex = argv.indexOf('--out');

  if (apply && revertIndex >= 0) {
    return { ok: false, error: 'Pass either --apply or --revert, not both.' };
  }

  if (revertIndex >= 0) {
    const revertPath = argv[revertIndex + 1];
    if (!revertPath) return { ok: false, error: '--revert requires a path to the ids file --apply --out produced.' };
    return { ok: true, args: { mode: 'revert', revertPath } };
  }

  if (apply) {
    const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined;
    if (!outPath) {
      return {
        ok: false,
        error:
          'Refusing --apply without --out <path>: this correction must stay reversible, and reversing it needs ' +
          'the exact list of page ids this run touched. Pass --out <path> to write that list.',
      };
    }
    return { ok: true, args: { mode: 'apply', outPath } };
  }

  return { ok: true, args: { mode: 'dry-run' } };
}
