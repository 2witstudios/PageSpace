/**
 * Backfill: correct `contentMode` for DOCUMENT pages storing markdown source
 * under `contentMode='html'` (multiplayer epic, Phase B gate).
 *
 * The collab content census (`collab-content-census.ts`) measured 3,003 such
 * pages against production: they begin `# `, their HTML tag histogram is
 * empty, and `contentMode` says `html` anyway. `htmlToYDoc` on markdown
 * source yields ONE paragraph containing the raw markdown as literal text —
 * every heading, list, code fence and table collapses into prose. Today that
 * is a rendering bug you can still fix by correcting the column; once it is a
 * Y.Doc it IS the document, permanently. This script is the fix, and it is a
 * hard gate on Phase E (seeding): nothing may seed a Y.Doc from one of these
 * pages until the label is correct.
 *
 * CHOICE RECORDED: this backfill corrects the LABEL (`contentMode` ->
 * 'markdown'), never the content. It does not convert the markdown source to
 * HTML. Two reasons:
 *   1. Converting would run the exact lossy markdown-through-an-HTML-parser
 *      path the census exists to warn about — the trap is that it succeeds
 *      without throwing and comes back as prose. Relabelling makes zero
 *      content changes, so there is nothing to verify per page beyond the
 *      classification itself.
 *   2. Phase K already scopes a dedicated markdown migration onto the real
 *      editing surface once `COLLAB_SCHEMA_VERSION` v1 is frozen. Relabelling
 *      is what puts these 3,003 pages into that correctly-scoped population
 *      instead of quietly resizing it after the fact.
 *
 * Classification is by content inspection (`classifyDocumentContent`, in
 * `../src/lib/editor/document-content-format.ts`), never by trusting
 * `contentMode` — see that module for why `detectPageContentFormat` in
 * packages/lib was not reused. A page that cannot be parsed confidently is
 * skipped and reported, never guessed at.
 *
 * NEVER PRINTS DOCUMENT CONTENT. Page ids and counts only, matching the
 * census's own rule — this runs against production user data.
 *
 * Reversible: only `contentMode` changes, `content`/`revision`/`updatedAt`
 * are untouched (updatedAt is pinned to its prior value so this correction
 * does not read as a user edit in the UI or GDPR export). Every corrected
 * page id is written to `--out <path>` as a JSON array, and `--revert <path>`
 * reads that file back and flips exactly those ids to 'html' again (guarded:
 * only pages still `contentMode='markdown'` are touched, so a page a user
 * has since re-saved through the real markdown migration is left alone).
 *
 * Dry-run is the default and only reports counts + ids; `--apply` requires
 * `--out <path>` so the correction is never un-reversible for want of a log.
 *
 * Usage:
 *   bun scripts/backfill-mislabelled-content-mode.ts                         # dry run (default, safe)
 *   bun scripts/backfill-mislabelled-content-mode.ts --apply --out ids.json  # live write
 *   bun scripts/backfill-mislabelled-content-mode.ts --revert ids.json       # undo a prior --apply
 *
 * Lives under apps/web/scripts/ (not repo-root scripts/) for the same reason
 * collab-content-census.ts does: the classifier needs apps/web's happy-dom
 * dependency, which the root workspace cannot resolve.
 *
 * Its testable logic (`planAndApplyBackfill`, `revertBackfill`,
 * `parseBackfillArgs`) lives in `../src/lib/editor/content-mode-backfill.ts`
 * so it runs under apps/web's ordinary vitest config — this file is a thin
 * argv/stdout/file-IO wrapper, untested itself, same split
 * collab-content-census.ts uses against src/lib/editor/census/.
 *
 * DO NOT run this against production yourself — the orchestrator holds the
 * production credential. Dry-run against production first, sanity-check the
 * reported count against the census's 3,003, then --apply with --out set to
 * a path that will actually be kept.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { getMigrationDb, getMigrationPool } from '@pagespace/db/db';
import {
  parseBackfillArgs,
  planAndApplyBackfill,
  revertBackfill,
} from '../src/lib/editor/content-mode-backfill';

async function main(): Promise<void> {
  const parsed = parseBackfillArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`❌ ${parsed.error}`);
    process.exit(1);
  }

  const db = getMigrationDb();
  const { args } = parsed;

  try {
    if (args.mode === 'revert') {
      const raw: unknown = JSON.parse(await readFile(args.revertPath!, 'utf8'));
      if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string')) {
        throw new Error(`${args.revertPath} must contain a JSON array of page id strings`);
      }
      const result = await revertBackfill(db, raw);
      console.log(
        `Revert complete. attempted: ${result.attempted}, reverted: ${result.reverted.length}, ` +
          `already changed since (skipped): ${result.skippedAlreadyChanged.length}`,
      );
      if (result.skippedAlreadyChanged.length > 0) {
        console.log(`  skipped ids: ${result.skippedAlreadyChanged.join(' ')}`);
      }
      return;
    }

    const apply = args.mode === 'apply';
    console.log(`${apply ? '' : '[DRY RUN] '}Scanning contentMode='html' DOCUMENT pages...`);
    const summary = await planAndApplyBackfill(db, { apply });

    console.log(
      `${apply ? 'Corrected' : 'Would correct'}: ${summary.corrected.length} of ${summary.scanned} scanned. ` +
        `Skipped (unparseable): ${summary.skippedUnparseable.length}. ` +
        `Skipped (concurrent modification): ${summary.skippedConcurrentModification.length}.`,
    );
    if (summary.corrected.length > 0) {
      console.log(`  page ids: ${summary.corrected.join(' ')}`);
    }
    if (summary.skippedUnparseable.length > 0) {
      console.log(
        `  unparseable page ids: ${summary.skippedUnparseable.map((s) => `${s.id}(${s.reason})`).join(' ')}`,
      );
    }
    if (summary.skippedConcurrentModification.length > 0) {
      console.log(`  concurrently-modified page ids: ${summary.skippedConcurrentModification.join(' ')}`);
    }

    if (apply) {
      await writeFile(args.outPath!, JSON.stringify(summary.corrected, null, 2));
      console.log(`Wrote ${summary.corrected.length} corrected page ids to ${args.outPath} — keep this to revert.`);
    }
  } finally {
    await getMigrationPool().end();
  }
}

// No import.meta.main guard: nothing imports this file (it is a CLI entry
// point, same as collab-content-census.ts), and import.meta.main is a Bun-ism
// the tsconfig ImportMeta type here doesn't declare.
try {
  await main();
} catch (err) {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
}
