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
import { and, asc, eq, gt, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import type { getMigrationDb } from '@pagespace/db/db';
import { createDomWorkspace, classifyDocumentContent } from './document-content-format';

export type BackfillDb = ReturnType<typeof getMigrationDb>;

const DEFAULT_BATCH_SIZE = 200;

export interface BackfillSummary {
  scanned: number;
  corrected: string[];
  skippedUnparseable: Array<{ id: string; reason: string }>;
  skippedConcurrentModification: string[];
}

/**
 * Scans every `contentMode='html'` DOCUMENT page (trashed included — a
 * restored page is seeded like any other, so its label matters just as
 * much), classifies its stored content by inspection, and either reports
 * (dry run) or corrects (`apply`) the ones holding markdown source.
 */
export async function planAndApplyBackfill(
  db: BackfillDb,
  { apply, batchSize = DEFAULT_BATCH_SIZE }: { apply: boolean; batchSize?: number },
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
        .select({ id: pages.id, content: pages.content, contentMode: pages.contentMode, updatedAt: pages.updatedAt })
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
        summary.corrected.push(...mislabelled.map((page) => page.id));
      } else {
        // Each page's compare-and-swap only touches its own row, so the
        // batch's writes run concurrently rather than one round trip at a
        // time — up to `batchSize` (200) in flight per batch.
        await Promise.all(
          mislabelled.map(async (page) => {
            // Compare-and-swap on the exact content read: a page edited
            // between the select and this write must not be relabelled
            // against content this run never actually classified. updatedAt
            // is pinned to its prior value — this is a label correction, not
            // a user edit.
            const written = await db
              .update(pages)
              .set({ contentMode: 'markdown', updatedAt: page.updatedAt })
              .where(and(eq(pages.id, page.id), eq(pages.content, page.content), eq(pages.contentMode, 'html')));

            if (written.rowCount === 0) {
              summary.skippedConcurrentModification.push(page.id);
            } else {
              summary.corrected.push(page.id);
            }
          }),
        );
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

/** Flips exactly the given page ids back to `contentMode='html'`, and only if still 'markdown'. */
export async function revertBackfill(db: BackfillDb, pageIds: string[]): Promise<RevertSummary> {
  if (pageIds.length === 0) {
    return { attempted: 0, reverted: [], skippedAlreadyChanged: [] };
  }

  // One batched UPDATE rather than one round trip per id: `RETURNING id`
  // reports exactly which of the given ids were still 'markdown' (and so
  // actually flipped), so a page a user has since re-saved through the real
  // markdown migration is reported as skipped rather than clobbered.
  const written = await db
    .update(pages)
    .set({ contentMode: 'html' })
    .where(and(inArray(pages.id, pageIds), eq(pages.contentMode, 'markdown')))
    .returning({ id: pages.id });

  const reverted = new Set(written.map((row) => row.id));
  return {
    attempted: pageIds.length,
    reverted: pageIds.filter((id) => reverted.has(id)),
    skippedAlreadyChanged: pageIds.filter((id) => !reverted.has(id)),
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
