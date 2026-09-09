/**
 * Collab seed fidelity audit — the Phase B exit criterion (multiplayer epic).
 *
 * Streams every DOCUMENT page and takes each `contentMode='html'` one through
 * the full seed path, HTML → ProseMirror → Y.Doc → ProseMirror → HTML, over
 * the frozen `COLLAB_SCHEMA_VERSION` v1 schema in `@pagespace/editor` — and,
 * on the same parse, through the shorter HTML → ProseMirror → HTML chain the
 * content census ran (`apps/web/scripts/collab-content-census.ts`). The two
 * are reported side by side and must agree; where they do not, the only thing
 * between them is `y-prosemirror`, and the report names what it changed.
 *
 * Three criteria, all hard blockers, no thresholds (see lib/seed-audit/
 * criteria.ts): one-pass stability, no decrease in any content-bearing
 * counter, and visible text preserved. Any page failing any of them on the
 * seed chain makes the run BLOCKED and the exit code non-zero. Seeding is
 * permanent — once a page is a Y.Doc the flattened version IS the document —
 * so a lossy page is a finding about the schema, never a rate to tolerate.
 *
 * READ-ONLY, and not on the honour system: every connection the pool opens is
 * put into `default_transaction_read_only` at the server
 * (`@pagespace/db/read-only-session`), the setting is read back before the
 * first real query, and `__tests__/collab-seed-audit.test.ts` fails the build
 * if any audit source grows a write.
 *
 * NEVER PRINTS DOCUMENT CONTENT. This runs against production user data. The
 * report is criterion names, construct keys, counts and at most three example
 * page ids per row — an id is a handle someone holding the credential can go
 * and look at; an excerpt is user content in a terminal scrollback. Failures
 * are reported by stage and error TYPE only, because ProseMirror quotes the
 * offending markup in its messages.
 *
 * ONE connection, ONE query at a time. `getMigrationPool()` is deliberately
 * `max: 1` so a long script cannot starve the deployment; a `Promise.all`
 * over a batch against it is a self-deadlock, and has been. Everything here
 * is sequential by construction.
 *
 * `contentMode='markdown'` pages are counted and skipped: they are markdown
 * source, not HTML, and reach this surface through the Phase K migration.
 * An html-mode page with no HTML element at all is markdown (or plain text)
 * under the wrong label; it is audited like any other but counted in its
 * own row, because Phase E must refuse to seed it regardless of what the
 * column says.
 *
 * Run from the repo root, with DATABASE_URL pointing at the database to audit:
 *
 *   bun run collab:seed-audit
 *
 * Only the report goes to stdout, so `> seed-audit.txt` captures it and
 * nothing else. Exit code 0 means PASS; 1 means BLOCKED, a processing failure,
 * or an interrupted run.
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
import { assertReadOnlySession, enforceReadOnlySession } from '@pagespace/db/read-only-session';
import { SCHEMA_HASH, COLLAB_SCHEMA_VERSION } from '@pagespace/editor/collab-schema';
import { createDomWorkspace } from '@pagespace/editor/dom-workspace';
import { auditPage } from './lib/seed-audit/analyze';
import { parseAuditArgs } from './lib/seed-audit/options';
import { auditPassed, createAuditAccumulator, formatAuditReport } from './lib/seed-audit/report';

async function main(): Promise<number> {
  const options = parseAuditArgs(process.argv.slice(2));

  // Registered before the pool is handed to drizzle, and therefore before it
  // has opened a connection to attach the guard to.
  enforceReadOnlySession(getMigrationPool());
  const db = getMigrationDb();
  assertReadOnlySession((await db.execute(sql`SHOW default_transaction_read_only`)).rows);

  process.stderr.write(
    `auditing against COLLAB_SCHEMA_VERSION ${COLLAB_SCHEMA_VERSION} (SCHEMA_HASH ${SCHEMA_HASH})\n`,
  );

  const workspace = createDomWorkspace();
  const audit = createAuditAccumulator();

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
        // batch after it state the DOCUMENT filter once. Trashed pages are
        // included: a restored page is seeded like any other.
        .where(and(eq(pages.type, 'DOCUMENT'), after === null ? undefined : gt(pages.id, after)))
        .orderBy(asc(pages.id))
        .limit(Math.min(options.batchSize, remaining));

      if (batch.length === 0) break;

      for (const page of batch) {
        // /\S/ rather than trim(): a whole-string copy per document, for a
        // question answered by the first non-space character.
        if (!/\S/.test(page.content)) {
          audit.recordEmpty();
        } else if (page.contentMode === 'markdown') {
          audit.recordMarkdownMode(page.id);
        } else {
          audit.recordHtml(page.id, auditPage(page.content, workspace));
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

  const snapshot = audit.snapshot();
  process.stdout.write(`${formatAuditReport(snapshot, { partial: interrupted })}\n`);
  return !interrupted && auditPassed(snapshot) ? 0 : 1;
}

process.exitCode = await main();
