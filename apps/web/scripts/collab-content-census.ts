/**
 * Collab content census — what real DOCUMENT pages contain that the editor
 * schema cannot represent (multiplayer epic, Phase B).
 *
 * Streams every `DOCUMENT` page and runs each one HTML -> ProseMirror -> HTML
 * against the SAME extension list `RichEditor` mounts, then reports which
 * constructs did not survive. Its output is the input to freezing
 * `COLLAB_SCHEMA_VERSION` v1: seeding a Y.Doc turns "dropped on next open" into
 * "permanently deleted", so what stored documents actually contain decides what
 * the schema must be able to represent.
 *
 * READ-ONLY, and not on the honour system: every connection is put into
 * `default_transaction_read_only` (see read-only-session.ts), and
 * read-only.test.ts fails the build if any census source grows a write.
 *
 * NEVER PRINTS DOCUMENT CONTENT. This runs against production user data. The
 * report is construct names, page counts, and at most three example page ids
 * per construct — a page id is a handle you can choose to go and look at; an
 * excerpt is user content in a terminal scrollback. Round-trip failures are
 * reported by error TYPE only, because ProseMirror quotes the offending markup
 * in its messages.
 *
 * Counts, never rates: "138 pages contain <img>" says what to put in v1;
 * "0.4% lossy" says nothing.
 *
 * `contentMode='markdown'` documents are tallied separately. They are markdown
 * source, not HTML, so there is nothing to round-trip yet — Phase K migrates
 * them onto this surface, and markdown natively carries images and checkboxes
 * the schema has no node for. Their tally is source-syntax detection.
 *
 * A `contentMode='html'` page that parses to NO element is markdown under the
 * wrong label — the first production run found 3,003 of them — so it is read a
 * second time by the markdown detector and tallied in its own table. Without
 * that, markdown syntax is measured over a quarter of the markdown documents
 * that exist, and images live almost entirely in the other three quarters.
 *
 * Images get a section of their own because the headline `<img>: 0` is a
 * tautology: the editor has no image node, so no document can contain one. What
 * the census can answer is where the images in MARKDOWN source point — a data
 * URI, a host somebody else controls, or a file PageSpace already stores — and
 * that decides what an image node's attributes have to hold before v1 freezes
 * them. Scheme and bare hostname only, never a URL (see census/images.ts).
 *
 * Magnitudes are the one measurement here that is a size rather than a
 * presence, and they exist for pagination: PaginationPlus breaks BETWEEN
 * blocks, so a table, a code fence or an image taller than a page cannot be
 * paginated at all (see census/magnitudes.ts).
 *
 * Trashed pages are included: a restored page is seeded like any other, so its
 * content is as much at stake.
 *
 * TEMPORARY BY DESIGN: this is Phase B input. Once COLLAB_SCHEMA_VERSION v1 is
 * frozen and the decision recorded, this script and src/lib/editor/census/
 * should be deleted rather than maintained — the drift guard, not a re-run of
 * the census, is what keeps the schema honest afterwards.
 *
 * Lives under apps/web/scripts/ rather than repo-root scripts/ because it needs
 * apps/web's own @tiptap deps and the live extension list, neither of which the
 * root workspace can resolve (same constraint as redteam-sandbox-injection.ts).
 *
 * Run from apps/web, with DATABASE_URL pointing at the database to census:
 *
 *   cd apps/web && bun run census
 *
 * (`bun run --filter web census` from the repo root works too, but turbo-style
 * line prefixes end up in the report; the report is the whole output here.)
 * That script wraps a `--tsconfig-override` — see tsconfig.census.json for why
 * bun needs to be told about the `@/*` alias. Only the report goes to stdout,
 * so `> census.txt` captures it and nothing else.
 *
 * Options:
 *   --limit N           stop after N documents (a smoke run before the full one)
 *   --batch-size N      rows per query (default 200)
 *   --progress-every N  progress line to stderr every N documents (default 500)
 *
 * Ctrl-C stops the scan and prints what it has, labelled INTERRUPTED.
 */

import { getMigrationDb, getMigrationPool } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { and, asc, eq, gt, sql } from '@pagespace/db/operators';
import { getSchema } from '@tiptap/core';
import { buildRichEditorExtensions } from '../src/lib/editor/rich-editor-extensions';
import { createDomWorkspace } from '../src/lib/editor/census/constructs';
import { analyzeHtmlDocument } from '../src/lib/editor/census/round-trip';
import { analyzeMarkdown } from '../src/lib/editor/census/markdown';
import { createCensusAccumulator, formatCensusReport } from '../src/lib/editor/census/report';
import { assertReadOnlySession, enforceReadOnlySession } from '../src/lib/editor/census/read-only-session';

interface Options {
  limit: number;
  batchSize: number;
  progressEvery: number;
}

function numericFlag(argv: string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;

  const value = Number(argv[index + 1]);
  // Refuse rather than fall back: `--limit` with a typo after it would
  // otherwise silently census the whole table when a sample was asked for.
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer, e.g. ${flag} 500`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  return {
    limit: numericFlag(argv, '--limit', Number.POSITIVE_INFINITY),
    batchSize: numericFlag(argv, '--batch-size', 200),
    progressEvery: numericFlag(argv, '--progress-every', 500),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Registered before the pool is handed to drizzle, and therefore before it
  // has opened a connection to attach the guard to.
  enforceReadOnlySession(getMigrationPool());
  const db = getMigrationDb();
  assertReadOnlySession((await db.execute(sql`SHOW default_transaction_read_only`)).rows);

  // isPaginated: false — PaginationPlus decorates the view for printing and
  // contributes nothing to what is stored, so a paginated page's CONTENT is the
  // same content. readOnly only adds the placeholder, which has no schema.
  // round-trip.test.ts holds all four combinations to one schema.
  const schema = getSchema(buildRichEditorExtensions({ readOnly: false, isPaginated: false }));

  // The one aggregate in the run. `isPaginated` has a column, an API field and
  // a paginated-layout extension behind it, and no UI that writes it, so
  // whether anything has it set is worth one query and cannot be answered by
  // reading page content.
  const [paginated] = (
    await db
      .select({ pages: sql<number>`count(*)` })
      .from(pages)
      .where(and(eq(pages.type, 'DOCUMENT'), eq(pages.isPaginated, true)))
  );
  const paginatedPages = Number(paginated?.pages ?? 0);

  const workspace = createDomWorkspace();
  const census = createCensusAccumulator();

  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write('\ninterrupted — finishing this batch, then reporting what was scanned\n');
  };
  process.on('SIGINT', onInterrupt);

  let scanned = 0;
  // Keyset pagination on the primary key rather than OFFSET: the scan holds no
  // cursor open across batches, so it is interruptible and costs the same on
  // the last page as on the first.
  let after: string | null = null;

  try {
    while (!interrupted && scanned < options.limit) {
      const remaining = options.limit - scanned;
      const batch = await db
        .select({ id: pages.id, content: pages.content, contentMode: pages.contentMode })
        .from(pages)
        // `and()` drops an undefined operand, so the first batch and every
        // batch after it state the DOCUMENT filter once.
        .where(and(eq(pages.type, 'DOCUMENT'), after === null ? undefined : gt(pages.id, after)))
        .orderBy(asc(pages.id))
        .limit(Math.min(options.batchSize, remaining));

      if (batch.length === 0) break;

      for (const page of batch) {
        // /\S/ rather than trim(): a whole-string copy per document, for a
        // question answered by the first non-space character.
        if (!/\S/.test(page.content)) {
          census.recordEmpty(page.contentMode);
        } else if (page.contentMode === 'markdown') {
          census.recordMarkdown(page.id, analyzeMarkdown(page.content, workspace));
        } else {
          const analysis = analyzeHtmlDocument(page.content, schema, workspace);
          census.recordHtml(page.id, analysis);
          // An html-mode page that parsed to no element is markdown wearing the
          // wrong label, and the HTML scan is blind to everything in it. Read it
          // a second time as what it is — otherwise the markdown numbers are
          // drawn from a quarter of the markdown documents that exist.
          if (analysis.status === 'analysed' && analysis.tagless) {
            census.recordMislabelledMarkdown(page.id, analyzeMarkdown(page.content, workspace));
          }
        }

        scanned += 1;
        if (scanned % options.progressEvery === 0) {
          process.stderr.write(`scanned ${scanned} documents\n`);
        }
      }

      after = batch[batch.length - 1].id;
    }
  } finally {
    process.off('SIGINT', onInterrupt);
    workspace.close();
    await getMigrationPool().end();
  }

  process.stdout.write(
    `${formatCensusReport(census.snapshot(), { partial: interrupted, paginatedPages })}\n`,
  );
}

await main();
