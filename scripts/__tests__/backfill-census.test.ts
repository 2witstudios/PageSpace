/**
 * THE OPERATOR'S READOUT for the node backfill, asserted as text.
 *
 * There was no test here at all, and the cost of that is on the record: the
 * derivation's census renamed one field, the script kept the old name, and
 * every total in the report a human reads before an irreversible one-shot
 * migration printed `NaN` — through a green monorepo typecheck, a green lint
 * and a green knip, because `scripts/` is inside no tsconfig and nothing
 * imported the backfill. The type is derived from `WorkspaceCensus` now, so
 * that exact regression is a compile error; this suite covers the half a type
 * cannot: whether the numbers MEAN what the line says they mean.
 *
 * Three things the census could not previously show an operator, one test group
 * each, because each is invisible after migration 0256 and none is recoverable:
 *
 *   1. a thread about to be put back on a grid the user removed it from,
 *   2. a workspace the derivation skipped, which 0256 then empties,
 *   3. a workspace counted into the totals that was never written.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveWorkspaceNodes,
  type WorkspaceBackfillSource,
  type WorkspaceDerivation,
} from '@pagespace/lib/agent-workspaces/workspace-node-backfill';
import {
  censusLine,
  emptyTotals,
  formatReport,
  recordNotWritten,
  recordWritten,
  runIsClean,
} from '../lib/backfill-census';

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

function source(overrides: Partial<WorkspaceBackfillSource> & { workspaceId: string }): WorkspaceBackfillSource {
  return { columns: [], panes: [], conversations: [], shells: [], ...overrides };
}

/**
 * Production shape #1 with the dismissal the old model leaves behind: a
 * two-pane grid whose second pane shows a thread the user closed months ago and
 * whose row nothing ever cleaned up.
 */
function dismissedWorkspace(): WorkspaceDerivation {
  return deriveWorkspaceNodes(
    source({
      workspaceId: 'ws-dismissed',
      columns: [{ id: 'c1', orderIndex: 0, widthFraction: null }],
      panes: [
        { id: 'p1', columnId: 'c1', orderIndex: 0, kind: 'chat', targetId: 't1', heightFraction: null },
        { id: 'p2', columnId: 'c1', orderIndex: 1, kind: 'chat', targetId: 't2', heightFraction: null },
      ],
      conversations: [{ id: 't1', createdAt: EPOCH }],
    }),
    { openConversationIds: new Set(['t1']), knownConversationIds: new Set(['t1', 't2']) },
  );
}

/** An ordinary workspace: two threads, two panes, nothing wrong with it. */
function healthyWorkspace(id = 'ws-ok'): WorkspaceDerivation {
  return deriveWorkspaceNodes(
    source({
      workspaceId: id,
      columns: [{ id: `${id}-c1`, orderIndex: 0, widthFraction: null }],
      panes: [
        { id: `${id}-p1`, columnId: `${id}-c1`, orderIndex: 0, kind: 'chat', targetId: `${id}-a`, heightFraction: null },
        { id: `${id}-p2`, columnId: `${id}-c1`, orderIndex: 1, kind: 'chat', targetId: `${id}-b`, heightFraction: null },
      ],
      conversations: [
        { id: `${id}-a`, createdAt: EPOCH },
        { id: `${id}-b`, createdAt: EPOCH },
      ],
    }),
    {
      openConversationIds: new Set([`${id}-a`, `${id}-b`]),
      knownConversationIds: new Set([`${id}-a`, `${id}-b`]),
    },
  );
}

/**
 * A workspace the derivation refuses. A pane id of pure whitespace survives the
 * old table (no constraint) and `validateTree` then reads it as blank — the
 * shape a `blank_id` skip was measured on.
 */
function skippedWorkspace(): WorkspaceDerivation {
  const derived = deriveWorkspaceNodes(
    source({
      workspaceId: 'ws-skipped',
      columns: [{ id: 'cs', orderIndex: 0, widthFraction: null }],
      panes: [
        { id: '   ', columnId: 'cs', orderIndex: 0, kind: 'chat', targetId: 's1', heightFraction: null },
        { id: 'ps2', columnId: 'cs', orderIndex: 1, kind: 'chat', targetId: 's2', heightFraction: null },
      ],
      conversations: [
        { id: 's1', createdAt: EPOCH },
        { id: 's2', createdAt: EPOCH },
      ],
    }),
    { openConversationIds: new Set(['s1', 's2']), knownConversationIds: new Set(['s1', 's2']) },
  );
  // The fixture is only useful if it really is a skip — a fixture that quietly
  // started passing would make every assertion below vacuous.
  expect(derived.skipped).not.toBeNull();
  expect(derived.rows).toEqual([]);
  return derived;
}

function reportOf(totals: ReturnType<typeof emptyTotals>, dryRun = true): string {
  return formatReport(totals, dryRun).join('\n');
}

// ---------------------------------------------------------------------------

describe('the totals are numbers, not NaN', () => {
  it('every headline total is a finite number after a real derivation', () => {
    const totals = emptyTotals();
    recordWritten(totals, healthyWorkspace());
    recordWritten(totals, dismissedWorkspace());
    for (const [key, value] of Object.entries(totals)) {
      if (typeof value !== 'number') continue;
      expect(Number.isFinite(value), `${key} is ${value}`).toBe(true);
    }
  });

  it('the report contains no NaN and no undefined anywhere', () => {
    const totals = emptyTotals();
    recordWritten(totals, healthyWorkspace());
    recordWritten(totals, dismissedWorkspace());
    recordNotWritten(totals, skippedWorkspace(), {
      reason: 'skipped',
      code: skippedWorkspace().skipped!.code,
      detail: skippedWorkspace().skipped!.detail,
    });
    const text = reportOf(totals);
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/undefined/);
  });

  it('the per-workspace line is readable for every workspace it describes', () => {
    for (const derived of [healthyWorkspace(), dismissedWorkspace(), skippedWorkspace()]) {
      const text = censusLine(derived);
      expect(text).not.toMatch(/NaN|undefined/);
      expect(text).toContain(derived.workspaceId);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. A thread about to be reopened
// ---------------------------------------------------------------------------

describe('the census shows a thread that will NOT be put back', () => {
  it('prints the pane rows read and the pane rows materialised as different numbers', () => {
    const totals = emptyTotals();
    recordWritten(totals, dismissedWorkspace());
    const text = reportOf(totals);
    expect(text).toMatch(/pane rows read\s+: 2/);
    expect(text).toMatch(/NOT materialised\s+: 1/);
    expect(text).toMatch(/pane rows materialised\s+: 1/);
  });

  it('itemises WHY each pane was not materialised', () => {
    const totals = emptyTotals();
    recordWritten(totals, dismissedWorkspace());
    const text = reportOf(totals);
    expect(text).toMatch(/dismissed \/ deleted\s+: 1/);
    expect(text).toMatch(/no conversation row\s+: 0/);
    expect(text).toContain('back on their grid');
  });

  it('says so on the workspace’s own line, not only in the totals', () => {
    // A run over thousands of workspaces is read one line at a time.
    expect(censusLine(dismissedWorkspace())).toContain('panes 2→1 (1 not a member)');
  });

  it('stays silent about a run where nothing was dropped', () => {
    const totals = emptyTotals();
    recordWritten(totals, healthyWorkspace());
    const text = reportOf(totals);
    expect(text).toMatch(/NOT materialised\s+: 0/);
    expect(text).not.toContain('dismissed / deleted');
    expect(censusLine(healthyWorkspace())).not.toContain('not a member');
  });

  it('does not let a drop break the members-to-nodes identity', () => {
    const totals = emptyTotals();
    recordWritten(totals, dismissedWorkspace());
    expect(totals.membersIn).toBe(totals.paneNodesOut);
    expect(runIsClean(totals)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. A skipped workspace
// ---------------------------------------------------------------------------

describe('the census makes a SKIPPED workspace impossible to miss', () => {
  function withSkip() {
    const totals = emptyTotals();
    totals.workspacesScanned = 2;
    recordWritten(totals, healthyWorkspace());
    const skip = skippedWorkspace();
    recordNotWritten(totals, skip, {
      reason: 'skipped',
      code: skip.skipped!.code,
      detail: skip.skipped!.detail,
    });
    return totals;
  }

  it('names the workspace, its code and what it held', () => {
    const text = reportOf(withSkip());
    expect(text).toContain('ws-skipped');
    expect(text).toMatch(/SKIPPED\(blank_id\)/);
    expect(text).toContain('held 2 pane(s), 2 thread(s), 0 shell(s)');
  });

  it('says what happens to it at 0256, rather than leaving a bare count', () => {
    const text = reportOf(withSkip());
    expect(text).toContain('NOT WRITTEN');
    expect(text).toContain('DO NOT APPLY 0256');
    expect(text).toContain('claimable into a different workspace');
  });

  it('FAILS THE RUN — the gate the procedure only asked a human to apply', () => {
    const totals = withSkip();
    // The members-to-nodes identity holds perfectly here: the skipped
    // workspace contributed nothing to either side of it. Under the old gate
    // this run exited 0 and an operator was told to proceed.
    expect(totals.membersIn).toBe(totals.paneNodesOut);
    expect(runIsClean(totals)).toBe(false);
    expect(reportOf(totals)).toContain('NOT SAFE TO CUT OVER');
  });

  it('fails the run for a WRITE FAILURE too, and names that workspace as well', () => {
    const totals = emptyTotals();
    recordWritten(totals, healthyWorkspace());
    recordNotWritten(totals, healthyWorkspace('ws-boom'), {
      reason: 'write_failed',
      code: 'DatabaseError',
      detail: 'duplicate key value violates unique constraint',
    });
    expect(runIsClean(totals)).toBe(false);
    const text = reportOf(totals);
    expect(text).toContain('ws-boom  WRITE FAILED(DatabaseError)');
    expect(text).toContain('duplicate key value violates unique constraint');
  });

  it('reports a clean run as clean, and only then', () => {
    const totals = emptyTotals();
    totals.workspacesScanned = 1;
    recordWritten(totals, healthyWorkspace());
    expect(runIsClean(totals)).toBe(true);
    const text = reportOf(totals);
    expect(text).toContain('✅ clean');
    expect(text).not.toContain('NOT WRITTEN');
    expect(text).not.toContain('NOT SAFE TO CUT OVER');
  });

  it('still calls a members-to-nodes mismatch a DEFECT', () => {
    const totals = emptyTotals();
    recordWritten(totals, healthyWorkspace());
    totals.paneNodesOut += 1;
    expect(runIsClean(totals)).toBe(false);
    expect(reportOf(totals)).toMatch(/❌ DEFECT: members in \(2\) ≠ pane nodes out \(3\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. A workspace counted but never written
// ---------------------------------------------------------------------------

describe('the headline totals count ONLY what was written', () => {
  it('adds nothing from a skipped workspace to any headline number', () => {
    const skip = skippedWorkspace();
    // The skipped derivation carries a fully populated census with empty rows —
    // that is exactly what used to be summed into the totals.
    expect(skip.census.membersIn).toBeGreaterThan(0);
    expect(skip.census.nodesOut).toBeGreaterThan(0);

    const totals = emptyTotals();
    recordNotWritten(totals, skip, {
      reason: 'skipped',
      code: skip.skipped!.code,
      detail: skip.skipped!.detail,
    });
    expect(totals.panesIn).toBe(0);
    expect(totals.membersIn).toBe(0);
    expect(totals.paneNodesOut).toBe(0);
    expect(totals.nodesOut).toBe(0);
    expect(totals.written).toBe(0);
    expect(totals.skipped).toBe(1);
  });

  it('adds nothing from a FAILED write either', () => {
    const totals = emptyTotals();
    recordNotWritten(totals, healthyWorkspace('ws-boom'), {
      reason: 'write_failed',
      code: 'DatabaseError',
      detail: 'connection terminated',
    });
    expect(totals.panesIn).toBe(0);
    expect(totals.nodesOut).toBe(0);
    expect(totals.failed).toBe(1);
    expect(totals.skipped).toBe(0);
  });

  it('keeps the skipped workspace’s own numbers, in the section that is about it', () => {
    // Not written does not mean not reported: `panesIn: 2` on a skip is the
    // size of the hole 0256 is about to make.
    const skip = skippedWorkspace();
    const totals = emptyTotals();
    recordNotWritten(totals, skip, {
      reason: 'skipped',
      code: skip.skipped!.code,
      detail: skip.skipped!.detail,
    });
    expect(totals.notWritten).toEqual([
      {
        workspaceId: 'ws-skipped',
        reason: 'skipped',
        code: 'blank_id',
        detail: expect.any(String),
        panesIn: 2,
        conversationsIn: 2,
        shellsIn: 0,
        membersIn: 2,
      },
    ]);
  });

  it('leaves the totals of a mixed run equal to the written workspaces alone', () => {
    const written = [healthyWorkspace('ws-a'), healthyWorkspace('ws-b')];
    const mixed = emptyTotals();
    for (const derived of written) recordWritten(mixed, derived);
    const skip = skippedWorkspace();
    recordNotWritten(mixed, skip, {
      reason: 'skipped',
      code: skip.skipped!.code,
      detail: skip.skipped!.detail,
    });

    const writtenOnly = emptyTotals();
    for (const derived of written) recordWritten(writtenOnly, derived);

    for (const key of ['panesIn', 'membersIn', 'paneNodesOut', 'nodesOut', 'seatedOut'] as const) {
      expect(mixed[key], key).toBe(writtenOnly[key]);
    }
  });

  it('labels a dry run as one, and an applied run as one', () => {
    const totals = emptyTotals();
    recordWritten(totals, healthyWorkspace());
    expect(reportOf(totals, true)).toContain('DRY RUN — nothing was written');
    expect(reportOf(totals, true)).toMatch(/would write\s+: 1/);
    expect(reportOf(totals, false)).toContain('(APPLIED)');
    expect(reportOf(totals, false)).toMatch(/written\s+: 1/);
    expect(reportOf(totals, false)).toContain('0256 may be applied');
  });
});
