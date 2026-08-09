/**
 * THE OPERATOR'S INSTRUMENT for the node backfill — the totals, the
 * per-workspace line, the report, and the one predicate that decides whether
 * the run may be followed by migration `0256`.
 *
 * Pure, and in its own file, for a reason with a history. `0256` is
 * destructive and irreversible; step 2 of the backfill's procedure is "run this
 * DRY and read the census", so this readout is the only thing standing between
 * a bad derivation and a state no restore recovers. It has already failed at
 * that job once: a rename of one census field left three call sites reading a
 * property that no longer existed, every total became `NaN`, and every gate in
 * the repository stayed green — `scripts/` is inside no tsconfig, and no test
 * anywhere imported the backfill. Moving the readout here makes it importable
 * without a database, which is what makes `__tests__/backfill-census.test.ts`
 * possible; the totals shape is DERIVED from `WorkspaceCensus` rather than
 * restated, so the next rename is a compile error instead of a silent `NaN`.
 *
 * What the census has to be able to show, because each one is invisible
 * otherwise and each one is unrecoverable after `0256`:
 *
 *   * **a thread about to be reopened** — pane rows read vs pane rows
 *     materialised, split by why the difference exists;
 *   * **a skipped workspace** — named individually, with what it held, under a
 *     banner, and reflected in the process exit code;
 *   * **a workspace counted but not written** — the headline totals count
 *     ONLY written workspaces, and everything else is in its own section.
 */

import type {
  WorkspaceCensus,
  WorkspaceDerivation,
} from '@pagespace/lib/agent-workspaces/workspace-node-backfill';

/**
 * A workspace that produced no rows, and everything an operator needs in order
 * to go and look at it.
 *
 * The census counts are carried here rather than folded into the totals because
 * a skipped workspace's numbers are a measure of the HOLE, not of the
 * migration: `panesIn: 12` on a skip means twelve panes that `0256` is about to
 * delete with nothing written in their place.
 */
export interface NotWrittenWorkspace {
  workspaceId: string;
  reason: 'skipped' | 'write_failed';
  /** A `DerivationSkip` code, or `write_failed`'s error class. */
  code: string;
  detail: string;
  panesIn: number;
  conversationsIn: number;
  shellsIn: number;
  membersIn: number;
}

export type BackfillTotals = {
  workspacesScanned: number;
  alreadyMigrated: number;
  written: number;
  skipped: number;
  failed: number;
  /**
   * DERIVED from `WorkspaceCensus`, never restated — see this module's header.
   *
   * Every one of these counts WRITTEN workspaces only. `recordCensus` used to
   * run before the skip check, so a workspace that wrote nothing still added
   * its members and its nodes to the headline, and — because the defect
   * assertion compares two of those same conflated numbers — a skip inflated
   * both sides equally and hid itself from the only automated check the run
   * makes.
   */
} & Pick<
  WorkspaceCensus,
  | 'panesIn'
  | 'panesDroppedNotMember'
  | 'conversationsIn'
  | 'shellsIn'
  | 'membersIn'
  | 'nodesOut'
  | 'paneNodesOut'
  | 'seatedOut'
  | 'membershipDropped'
> & {
  /** `DerivationNoteCode` → how many panes/threads it fired for, across written workspaces. */
  notes: Record<string, number>;
  /** Skip code → how many workspaces it refused. */
  skips: Record<string, number>;
  /** Every workspace that produced no rows, named. */
  notWritten: NotWrittenWorkspace[];
};

export function emptyTotals(): BackfillTotals {
  return {
    workspacesScanned: 0,
    alreadyMigrated: 0,
    written: 0,
    skipped: 0,
    failed: 0,
    panesIn: 0,
    panesDroppedNotMember: 0,
    conversationsIn: 0,
    shellsIn: 0,
    membersIn: 0,
    nodesOut: 0,
    paneNodesOut: 0,
    seatedOut: 0,
    membershipDropped: 0,
    notes: {},
    skips: {},
    notWritten: [],
  };
}

/**
 * Add one WRITTEN workspace to the totals.
 *
 * Called only after the derivation produced rows AND (on a live run) those rows
 * committed. Nothing else reaches the headline.
 */
export function recordWritten(totals: BackfillTotals, derived: WorkspaceDerivation): void {
  const census = derived.census;
  totals.written += 1;
  totals.panesIn += census.panesIn;
  totals.panesDroppedNotMember += census.panesDroppedNotMember;
  totals.conversationsIn += census.conversationsIn;
  totals.shellsIn += census.shellsIn;
  totals.membersIn += census.membersIn;
  totals.nodesOut += census.nodesOut;
  totals.paneNodesOut += census.paneNodesOut;
  totals.seatedOut += census.seatedOut;
  totals.membershipDropped += census.membershipDropped;
  for (const note of derived.notes) {
    totals.notes[note.code] = (totals.notes[note.code] ?? 0) + 1;
  }
}

/** Record a workspace that wrote nothing, in its own section and its own counters. */
export function recordNotWritten(
  totals: BackfillTotals,
  derived: WorkspaceDerivation,
  entry: { reason: NotWrittenWorkspace['reason']; code: string; detail: string },
): void {
  const census = derived.census;
  if (entry.reason === 'skipped') {
    totals.skipped += 1;
    totals.skips[entry.code] = (totals.skips[entry.code] ?? 0) + 1;
  } else {
    totals.failed += 1;
  }
  totals.notWritten.push({
    workspaceId: derived.workspaceId,
    reason: entry.reason,
    code: entry.code,
    detail: entry.detail,
    panesIn: census.panesIn,
    conversationsIn: census.conversationsIn,
    shellsIn: census.shellsIn,
    membersIn: census.membersIn,
  });
}

/** The per-workspace line. `panes in→out` shows the drop; `(N not a member)` says why. */
export function censusLine(derived: WorkspaceDerivation): string {
  const c = derived.census;
  const notes = derived.notes.length === 0 ? '' : ` · ${derived.notes.map((note) => note.code).join(',')}`;
  const dropped = c.panesDroppedNotMember === 0 ? '' : ` (${c.panesDroppedNotMember} not a member)`;
  return (
    `${c.workspaceId}: panes ${c.panesIn}→${c.paneNodesOut - c.seatedOut}${dropped}, ` +
    `threads ${c.conversationsIn}, shells ${c.shellsIn}, ` +
    `members ${c.membersIn}→${c.paneNodesOut}, seated ${c.seatedOut}, nodes ${c.nodesOut}${notes}`
  );
}

/**
 * MAY MIGRATION `0256` BE APPLIED AFTER THIS RUN? The process exit code, and
 * the only automated judgement the backfill makes.
 *
 * Three conditions, and the second and third are new. `membersIn ===
 * paneNodesOut` was the whole gate: every member becomes exactly one pane node,
 * and a difference means a thread lost its node or grew a second one. But a
 * SKIPPED workspace is not a smaller version of that failure, it is a different
 * and larger one — `0256` drops the layout tables and the membership columns
 * outright, so a workspace with no nodes does not stay on the old model, it
 * loses its grid entirely and its threads, belonging to no node, read as
 * homeless and become claimable into a different workspace. There was no gate
 * on that at all; the procedure asked a human to notice.
 */
export function runIsClean(totals: BackfillTotals): boolean {
  return totals.membersIn === totals.paneNodesOut && totals.skipped === 0 && totals.failed === 0;
}

function line(label: string, value: string | number): string {
  return `  ${label.padEnd(24)}: ${value}`;
}

/**
 * The whole operator readout, as lines. Returned rather than printed so a test
 * can read exactly what a human would — the `NaN` regression was invisible
 * precisely because nothing ever looked at this output.
 */
export function formatReport(totals: BackfillTotals, dryRun: boolean): string[] {
  const out: string[] = [
    '',
    `── census ${dryRun ? '(DRY RUN — nothing was written)' : '(APPLIED)'} ─────────────────────`,
    line('live workspaces scanned', totals.workspacesScanned),
    line('already migrated (skip)', totals.alreadyMigrated),
    line(dryRun ? 'would write' : 'written', totals.written),
    line('skipped (NOT derivable)', totals.skipped),
    line('write failures', totals.failed),
    '',
    `  ── ${dryRun ? 'what WOULD be written' : 'what WAS written'} ──`,
    line('pane rows read', totals.panesIn),
    line('  NOT materialised', totals.panesDroppedNotMember),
  ];

  // The threads that do not come back, itemised. This is the finding that
  // cannot be corrected after the fact, so it is stated as a count of real
  // panes rather than left to be inferred from a difference of two totals.
  if (totals.panesDroppedNotMember > 0) {
    out.push(
      line('    dismissed / deleted', totals.notes.chat_pane_not_a_member ?? 0),
      line('    no conversation row', totals.notes.chat_pane_no_conversation ?? 0),
      '  ↳ panes bound to threads that are NOT members. Materialising one would put a',
      '    thread the user closed back on their grid; these are deliberately dropped.',
    );
  }

  out.push(
    line('pane rows materialised', totals.panesIn - totals.panesDroppedNotMember),
    line('open conversations in', totals.conversationsIn),
    line('shells in', totals.shellsIn),
    line('members in', totals.membersIn),
    line('pane nodes out', totals.paneNodesOut),
    line('  of which seated', totals.seatedOut),
    line('total nodes out', totals.nodesOut),
    line('membership dropped', totals.membershipDropped),
    '',
    line('anomalies', JSON.stringify(totals.notes)),
  );

  // A workspace that wrote nothing goes dark at `0256` and takes its threads
  // with it. Named individually, under a banner, with what it held — the
  // previous report printed a bare `skipped: N` above a totals block those
  // same workspaces had already been counted into.
  if (totals.notWritten.length > 0) {
    out.push('', '  ── NOT WRITTEN — read every line of this ──');
    out.push(
      `  ❌ ${totals.notWritten.length} workspace(s) produced no rows. Migration 0256 DROPS the layout`,
      '     tables and the membership columns, so each of these loses its grid outright and',
      '     its threads become claimable into a different workspace. DO NOT APPLY 0256.',
      '',
    );
    for (const entry of totals.notWritten) {
      out.push(
        `     ${entry.workspaceId}  ${entry.reason === 'skipped' ? 'SKIPPED' : 'WRITE FAILED'}(${entry.code})` +
          `  held ${entry.panesIn} pane(s), ${entry.conversationsIn} thread(s), ${entry.shellsIn} shell(s)`,
        `        ${entry.detail}`,
      );
    }
    out.push('', line('skips', JSON.stringify(totals.skips)));
  }

  out.push('');
  if (totals.membersIn !== totals.paneNodesOut) {
    // Computed over WRITTEN workspaces only, so a skip can no longer inflate
    // both sides of it symmetrically and hide itself.
    out.push(`❌ DEFECT: members in (${totals.membersIn}) ≠ pane nodes out (${totals.paneNodesOut})`);
  }
  out.push(
    runIsClean(totals)
      ? `✅ clean — every scanned workspace is accounted for${dryRun ? '; this was a DRY RUN' : ', and 0256 may be applied'}`
      : '❌ NOT SAFE TO CUT OVER — resolve everything above before applying migration 0256',
  );
  return out;
}
