/**
 * THE CHOKE-POINT GUARD — every `messages` write site is classified.
 *
 * Epic "Agent-Session Single Source of Truth", spec §3 clause 2: *every*
 * durable message write bumps `conversations.rev` and emits, in the SAME
 * transaction, from ONE repository choke point. A write that lands outside
 * that choke point commits without a rev bump, so every open pane keeps
 * showing pre-write content indefinitely: `syncWatchedConversationRevs`
 * compares revs and nothing else, so an unbumped rev is indistinguishable
 * from "nothing happened" and the panes never heal.
 *
 * That is not a property any single unit test can hold, because the failure
 * mode is a NEW write site somewhere else in the tree. So this is a
 * structural scan: it walks the shipped source, finds every statement that
 * INSERTs / UPDATEs / DELETEs `messages`, and fails unless the file is
 * either the choke point itself or a CLASSIFIED EXEMPTION with a written
 * reason.
 *
 * This reinstates the pattern of the deleted
 * `unified-message-dual-write-drift.test.ts` (the Phase 4 writer-classification
 * / freeze guard). Its removal at the contract PR is precisely why three
 * bypasses — the undo service, the trash path, and the retention sweep —
 * shipped unnoticed.
 *
 * ── ADDING A WRITE SITE ────────────────────────────────────────────────────
 * The default answer is "route it through `messageRepository`". Only add to
 * EXEMPT_WRITERS if the write genuinely cannot bump a rev, and say why in the
 * `reason` — the reason is the artifact this test exists to protect.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// vitest runs with cwd = apps/web.
const REPO_ROOT = resolve(process.cwd(), '../..');

/** Trees that ship code. `apps/e2e` is a test harness, not shipped runtime. */
const SCANNED_ROOTS = ['apps/web/src', 'apps/realtime/src', 'apps/processor/src', 'packages/lib/src', 'packages/db/src'];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', 'drizzle', '__tests__']);

/**
 * THE CHOKE POINT. These two files, and only these two, are allowed to write
 * `messages` without justification — they are the implementation of the
 * invariant (`unified-message-leg.ts` is `message-repository.ts`'s own
 * in-transaction statement helper, always called on the caller's `tx`).
 */
const CHOKE_POINT = [
  'apps/web/src/lib/repositories/message-repository.ts',
  'apps/web/src/lib/repositories/unified-message-leg.ts',
];

/**
 * CLASSIFIED EXEMPTIONS. Each one is a deliberate product decision, not an
 * oversight. The test pins the classification so that flipping it requires
 * editing this list.
 */
const EXEMPT_WRITERS: Array<{ file: string; reason: string }> = [
  {
    file: 'packages/lib/src/repositories/conversation-cleanup.ts',
    reason:
      'DESTROYS the conversation row in the same transaction as its messages (page/drive permanent ' +
      'delete). There is no surviving `conversations` row to bump a rev on, and no room to emit ' +
      'into that outlives the statement — the conversation itself is the thing being deleted. ' +
      'Panes are healed by the page/drive deletion events that this path already fans out, which ' +
      'carry strictly more information than a rev bump would.',
  },
  {
    file: 'packages/lib/src/compliance/retention/retention-engine.ts',
    reason:
      'BULK ADMINISTRATIVE SWEEP of rows that are ALREADY soft-deleted (`isActive: false`) and past ' +
      'the retention cutoff. Every one of these rows was hidden from every reader — and had its rev ' +
      'bumped and its event emitted — at soft-delete time, by the choke point. The hard delete ' +
      'changes nothing any client can observe, so a per-row rev bump would emit pure noise (and a ' +
      'nightly cron fanning out thousands of no-op events is a real cost). Exempt because the ' +
      'user-visible transition already emitted, not because deletion is unimportant.',
  },
];

const ALLOWED = new Set([...CHOKE_POINT, ...EXEMPT_WRITERS.map((e) => e.file)]);

/**
 * `.insert(X)`, `.update(X)`, `.delete(X)` where X is whatever local name this
 * file bound the `messages` table to — plus raw SQL against the table.
 *
 * The literal-`messages` form is not enough. Four shipped files already import
 * the table under an alias (`messages as unifiedMessages` in
 * `agent-communication-tools.ts`, `messages as globalMessages` in
 * `session-tools-runtime.ts`, and two more), so `.insert(unifiedMessages)` was
 * invisible to this scan. All four happen to be read-only today, which means
 * the guard passed for the right answer by luck — and the guard's own stated
 * purpose is catching a NEW write site somewhere in the tree, which is exactly
 * the case luck does not cover.
 */
function writeStatementPattern(src: string): RegExp {
  // Every local binding of the `messages` table in this file: the plain import
  // and any `messages as alias` rename.
  const names = new Set(['messages']);
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*schema\/conversations['"]/g;
  for (const match of src.matchAll(importRe)) {
    for (const clause of match[1].split(',')) {
      const aliased = clause.trim().match(/^messages\s+as\s+(\w+)$/);
      if (aliased) names.add(aliased[1]);
    }
  }
  const alternation = [...names].join('|');
  return new RegExp(
    // Query-builder writes through any local binding…
    `\\.\\s*(insert|update|delete)\\s*\\(\\s*(${alternation})\\s*\\)`
    // …or raw SQL that bypasses the builder entirely.
    + `|(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+"messages"`,
    'i',
  );
}

const hasWriteStatement = (src: string): boolean => writeStatementPattern(src).test(src);

/**
 * Comments are not code. This module's whole subject is where `messages`
 * writes live, so the files it guards are exactly the files whose doc comments
 * quote statements like `tx.update(messages)` while explaining why they no
 * longer do that — and a guard that flags its own documentation trains people
 * to weaken it. Crude but sufficient: block comments, line comments, and the
 * string/template bodies that could hide an apostrophe-laden `//`.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Trailing comments too, but never the `//` of a `https://` URL.
    .replace(/(?<!:)\/\/.*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...sourceFiles(join(dir, entry.name)));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const repoRel = (file: string) => relative(REPO_ROOT, file).split(sep).join('/');

/** Every shipped file containing at least one `messages` write statement. */
const WRITER_FILES: string[] = SCANNED_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
  .filter((file) => {
    const rel = repoRel(file);
    // The db package's own test factories are seeding helpers, not runtime.
    if (rel.startsWith('packages/db/src/test/')) return false;
    return hasWriteStatement(stripComments(readFileSync(file, 'utf8')));
  })
  .map(repoRel)
  .sort();

describe('messages write-site classification (choke-point guard)', () => {
  it('is actually scanning something (the choke point is found)', () => {
    // If the scan silently matched nothing — wrong root, renamed table — the
    // whole guard would pass vacuously.
    expect(WRITER_FILES).toContain('apps/web/src/lib/repositories/message-repository.ts');
    expect(WRITER_FILES.length).toBeGreaterThanOrEqual(CHOKE_POINT.length);
  });

  it('every `messages` write site is the repository choke point or a classified exemption', () => {
    const unclassified = WRITER_FILES.filter((file) => !ALLOWED.has(file));
    expect(unclassified).toEqual([]);
  });

  it('the undo path is NOT exempt — it writes through the repository', () => {
    // Undo soft-deletes a range of messages a user is very likely watching, in
    // response to that user's own click. It is the single least exemptable
    // write in the system: not bulk, not administrative, not invisible.
    expect(WRITER_FILES).not.toContain('apps/web/src/services/api/ai-undo-service.ts');
  });

  it('every exemption states a reason', () => {
    for (const { file, reason } of EXEMPT_WRITERS) {
      expect(reason.length, `${file} needs a real classification reason`).toBeGreaterThan(80);
    }
  });

  it('no exemption is stale (every classified file still writes `messages`)', () => {
    // A file that stopped writing should lose its exemption rather than keep a
    // standing licence nobody re-reads.
    for (const { file } of EXEMPT_WRITERS) {
      expect(WRITER_FILES, `${file} no longer writes messages — drop its exemption`).toContain(file);
    }
  });
});
