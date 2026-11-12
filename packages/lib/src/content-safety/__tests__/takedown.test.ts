import { describe, it, expect, beforeEach } from 'vitest';
import type {
  ContentCase,
  ContentCaseSnapshot,
  ContentCaseStep,
} from '@pagespace/db/schema/content-safety';
import { GLOBAL_TAKEDOWN_STEPS, type GlobalTakedownStep } from '../takedown-plan';
import {
  evidenceKeyFor,
  resweepGlobalTakedown,
  runGlobalTakedown,
  runLinearCase,
  type ContentReferences,
  type TakedownAlert,
  type TakedownDeps,
  type TakedownOriginal,
} from '../takedown';

const HASH = 'a'.repeat(64);
const CASE_ID = 'case-1';

const emptyRefs = (): ContentReferences => ({
  pageIds: [],
  fileIds: [],
  driveIds: [],
  uploaderUserIds: [],
  channelMessageIds: [],
  directMessageIds: [],
  aiMessageIds: [],
  conversationIds: [],
  truncated: false,
});

/** In-memory world: two buckets, an evidence bucket, a blocklist and one case. */
function createWorld(options: { category?: ContentCase['category']; evidence?: boolean; snapshot?: ContentCaseSnapshot } = {}) {
  const uploads = new Map<string, number>([
    [`files/${HASH}/original`, 1234],
    [`cache/${HASH}/thumbnail.webp`, 50],
  ]);
  const publish = new Map<string, number>([
    [`assets/${HASH}`, 1234],
    [`assets/cache/${HASH}/thumbnail.webp`, 50],
  ]);
  const evidence = new Map<string, number>();
  const blocks = new Map<string, { category: string; caseId: string | null }>();
  const alerts: TakedownAlert[] = [];
  const suspended: string[] = [];
  const failNext = new Set<GlobalTakedownStep>();
  const calls: string[] = [];
  const world = {
    uploads,
    publish,
    evidence,
    blocks,
    alerts,
    suspended,
    failNext,
    calls,
    evidenceConfigured: options.evidence ?? true,
    references: { ...emptyRefs(), pageIds: ['page-1'], driveIds: ['drive-1'], uploaderUserIds: ['user-1', 'user-2'] },
    corruptCopy: false,
    row: {
      id: CASE_ID,
      targetType: 'content_hash',
      targetId: HASH,
      contentHash: HASH,
      status: 'open',
      category: options.category ?? 'csam',
      reporterUserId: null,
      reporterContact: null,
      reason: 'reported',
      snapshot: options.snapshot ?? { takedown: { kind: 'global', actorUserId: 'admin-1' } },
      steps: [] as ContentCaseStep[],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as ContentCase,
  };

  const boom = (step: GlobalTakedownStep) => {
    calls.push(step);
    if (failNext.delete(step)) throw new Error(`${step} failed`);
  };

  const deps: TakedownDeps = {
    cases: {
      load: async (id) => (id === CASE_ID ? structuredClone(world.row) : null),
      appendStep: async (_id, step) => {
        world.row.steps = [...(world.row.steps ?? []), step];
      },
      setStatus: async (_id, status) => {
        world.row.status = status;
      },
      mergeSnapshot: async (_id, patch) => {
        world.row.snapshot = { ...world.row.snapshot, ...patch };
      },
      upsertBlock: async (block) => {
        boom('block');
        if (!blocks.has(block.contentHash)) blocks.set(block.contentHash, { category: block.category, caseId: block.caseId });
      },
      collectReferences: async () => {
        boom('record_references');
        return world.references;
      },
    },
    storage: {
      evidenceConfigured: () => world.evidenceConfigured,
      findOriginal: async (hash): Promise<TakedownOriginal | null> => {
        const key = `files/${hash}/original`;
        const size = uploads.get(key);
        if (size !== undefined) return { store: 'uploads', key, size };
        const assetSize = publish.get(`assets/${hash}`);
        return assetSize === undefined ? null : { store: 'publish', key: `assets/${hash}`, size: assetSize };
      },
      hasAnyObjects: async (hash) =>
        [...uploads.keys(), ...publish.keys()].some((key) => key.includes(hash)),
      headEvidence: async (key) => (evidence.has(key) ? { size: evidence.get(key)! } : null),
      copyToEvidence: async (source, key) => {
        boom('preserve');
        evidence.set(key, world.corruptCopy ? source.size - 1 : source.size);
      },
      deleteFromUploads: async (hash) => {
        boom('delete_uploads');
        let deleted = 0;
        for (const key of [...uploads.keys()]) if (key.includes(hash) && uploads.delete(key)) deleted += 1;
        return deleted;
      },
      deleteFromPublish: async (hash) => {
        boom('delete_public');
        let deleted = 0;
        for (const key of [...publish.keys()]) if (key.includes(hash) && publish.delete(key)) deleted += 1;
        return deleted;
      },
    },
    suspendUser: async ({ userId }) => {
      boom('suspend_uploader');
      if (suspended.includes(userId)) return { status: 'already_suspended' };
      suspended.push(userId);
      return { status: 'suspended', revokedSessions: 1 };
    },
    alert: async (alert) => {
      alerts.push(alert);
    },
  };
  return { world, deps };
}

const stepStates = (steps: ContentCaseStep[] | null) => (steps ?? []).map((s) => `${s.step}:${s.status}`);

describe('runGlobalTakedown', () => {
  let world: ReturnType<typeof createWorld>['world'];
  let deps: TakedownDeps;

  beforeEach(() => {
    ({ world, deps } = createWorld());
  });

  it('blocks, preserves, deletes from both buckets, records references and finishes the case', async () => {
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'actioned', caseId: CASE_ID });
    expect(world.blocks.get(HASH)).toEqual({ category: 'csam', caseId: CASE_ID });
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(1234);
    expect([...world.uploads.keys()]).toEqual([]);
    expect([...world.publish.keys()]).toEqual([]);
    expect(world.row.status).toBe('actioned');
    expect(world.row.snapshot?.references).toEqual(world.references);
    expect(world.row.snapshot?.evidenceKey).toBe(evidenceKeyFor(CASE_ID, HASH));
    expect(stepStates(world.row.steps)).toEqual([
      'block:ok',
      'preserve:ok',
      'delete_uploads:ok',
      'delete_public:ok',
      'record_references:ok',
    ]);
    expect(world.suspended).toEqual([]);
  });

  it('runs the block before any other effect', async () => {
    await runGlobalTakedown(CASE_ID, deps);
    expect(world.calls[0]).toBe('block');
  });

  it('stops at a failed block with nothing preserved or deleted', async () => {
    world.failNext.add('block');
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'block' });
    expect(world.blocks.size).toBe(0);
    expect(world.evidence.size).toBe(0);
    expect(world.uploads.size).toBe(2);
    expect(world.publish.size).toBe(2);
  });

  it.each(GLOBAL_TAKEDOWN_STEPS)('resumes at %s after it failed, without repeating finished steps', async (step) => {
    world.row.snapshot = { takedown: { kind: 'global', actorUserId: 'admin-1', suspendUploader: true } };
    world.failNext.add(step);

    const first = await runGlobalTakedown(CASE_ID, deps);
    expect(first).toMatchObject({ status: 'open', failedStep: step });
    expect(world.row.status).toBe('open');
    const callsBeforeResume = [...world.calls];
    expect(callsBeforeResume.at(-1)).toBe(step);

    const second = await runGlobalTakedown(CASE_ID, deps);
    expect(second.status).toBe('actioned');
    // The resumed run starts at the failed step: nothing before it is called again.
    const resumedCalls = world.calls.slice(callsBeforeResume.length);
    expect(resumedCalls[0]).toBe(step);
    for (const earlier of GLOBAL_TAKEDOWN_STEPS.slice(0, GLOBAL_TAKEDOWN_STEPS.indexOf(step))) {
      expect(resumedCalls).not.toContain(earlier);
    }
    expect(world.uploads.size).toBe(0);
    expect(world.publish.size).toBe(0);
    expect(world.evidence.size).toBe(1);
    expect(world.suspended).toEqual(['user-1', 'user-2']);
  });

  it('is a no-op on a finished case', async () => {
    await runGlobalTakedown(CASE_ID, deps);
    const calls = world.calls.length;
    const alerts = world.alerts.length;

    expect((await runGlobalTakedown(CASE_ID, deps)).status).toBe('actioned');
    expect(world.calls.length).toBe(calls);
    expect(world.alerts.length).toBe(alerts);
  });

  it('refuses to delete when the evidence copy does not match the source size', async () => {
    world.corruptCopy = true;
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
    expect(world.uploads.has(`files/${HASH}/original`)).toBe(true);
    expect(world.publish.has(`assets/${HASH}`)).toBe(true);
  });

  it('preserves from the public bucket when the private original is already gone', async () => {
    world.uploads.clear();
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(1234);
    expect(world.publish.size).toBe(0);
  });

  it('skips preservation when no object exists for the hash at all', async () => {
    world.uploads.clear();
    world.publish.clear();
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(stepStates(world.row.steps)).toContain('preserve:skipped');
    expect(world.blocks.has(HASH)).toBe(true);
  });

  it('does not delete derived CSAM objects when there is no original left to preserve', async () => {
    world.uploads.delete(`files/${HASH}/original`);
    world.publish.delete(`assets/${HASH}`);
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
    expect(world.uploads.has(`cache/${HASH}/thumbnail.webp`)).toBe(true);
  });

  describe('CSAM with no evidence storage', () => {
    beforeEach(() => {
      ({ world, deps } = createWorld({ evidence: false }));
    });

    it('blocks the hash, deletes nothing, and waits', async () => {
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result).toMatchObject({ status: 'awaiting_evidence', haltReason: 'awaiting_evidence' });
      expect(world.blocks.has(HASH)).toBe(true);
      expect(world.uploads.size).toBe(2);
      expect(world.publish.size).toBe(2);
      expect(world.row.status).toBe('awaiting_evidence');
    });

    it('alerts once that the case stopped at the evidence step', async () => {
      await runGlobalTakedown(CASE_ID, deps);
      await runGlobalTakedown(CASE_ID, deps);

      expect(world.alerts).toEqual([{ event: 'awaiting_evidence', caseId: CASE_ID, category: 'csam' }]);
    });

    it('ignores skipPreservation', async () => {
      world.row.snapshot = { takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'x' } };
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result.status).toBe('awaiting_evidence');
      expect(world.uploads.size).toBe(2);
    });

    it('finishes once evidence storage is configured', async () => {
      await runGlobalTakedown(CASE_ID, deps);
      world.evidenceConfigured = true;

      const result = await runGlobalTakedown(CASE_ID, deps);
      expect(result.status).toBe('actioned');
      expect(world.evidence.size).toBe(1);
      expect(world.uploads.size).toBe(0);
      expect(world.alerts.map((a) => a.event)).toEqual(['awaiting_evidence', 'actioned']);
    });
  });

  describe('other categories', () => {
    it('deletes without a copy when the admin skips preservation', async () => {
      ({ world, deps } = createWorld({
        category: 'malware',
        evidence: false,
        snapshot: { takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'known sample' } },
      }));
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result.status).toBe('actioned');
      expect(world.evidence.size).toBe(0);
      expect(world.uploads.size).toBe(0);
      expect(stepStates(world.row.steps)).toContain('preserve:skipped');
    });

    it('stops for a decision when there is no evidence storage and no skip', async () => {
      ({ world, deps } = createWorld({ category: 'illegal_other', evidence: false }));
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result).toMatchObject({ status: 'open', haltReason: 'preservation_decision_required' });
      expect(world.uploads.size).toBe(2);
    });
  });

  it('suspends every recorded uploader except the acting admin', async () => {
    world.row.snapshot = { takedown: { kind: 'global', actorUserId: 'user-2', suspendUploader: true } };
    await runGlobalTakedown(CASE_ID, deps);

    expect(world.suspended).toEqual(['user-1']);
  });

  it('alerts when the case is actioned', async () => {
    await runGlobalTakedown(CASE_ID, deps);
    expect(world.alerts).toEqual([{ event: 'actioned', caseId: CASE_ID, category: 'csam' }]);
  });

  it('still finishes when the alert cannot be sent', async () => {
    deps = { ...deps, alert: async () => { throw new Error('smtp down'); } };
    expect((await runGlobalTakedown(CASE_ID, deps)).status).toBe('actioned');
  });

  it('rejects a case that is not a global takedown', async () => {
    world.row.snapshot = { takedown: { kind: 'avatar' } };
    await expect(runGlobalTakedown(CASE_ID, deps)).rejects.toThrow(/not a global takedown/);
  });

  it('rejects a policy case: a policy takedown never purges a hash', async () => {
    world.row.category = 'policy';
    await expect(runGlobalTakedown(CASE_ID, deps)).rejects.toThrow(/policy/);
    expect(world.blocks.size).toBe(0);
  });
});

describe('resweepGlobalTakedown', () => {
  it('preserves and deletes bytes that landed after the first pass', async () => {
    const { world, deps } = createWorld();
    world.uploads.clear();
    world.publish.clear();
    await runGlobalTakedown(CASE_ID, deps);
    expect(world.evidence.size).toBe(0);

    // A presigned PUT issued before the block lands its bytes afterwards.
    world.uploads.set(`files/${HASH}/original`, 999);
    const result = await resweepGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(999);
    expect(world.uploads.size).toBe(0);
  });

  it('keeps the first preserved copy and still deletes', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    world.uploads.set(`files/${HASH}/original`, 1234);

    await resweepGlobalTakedown(CASE_ID, deps);
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(1234);
    expect(world.uploads.size).toBe(0);
  });
});

describe('runLinearCase', () => {
  it('runs each step once, records it, and resumes at the step that failed', async () => {
    const { world, deps } = createWorld({ category: 'policy', snapshot: { takedown: { kind: 'park_drive' } } });
    const ran: string[] = [];
    let fail = true;
    const plan = [
      { step: 'one', run: async () => { ran.push('one'); return 'did one'; } },
      { step: 'two', run: async () => { ran.push('two'); if (fail) throw new Error('nope'); } },
    ];

    const first = await runLinearCase(CASE_ID, plan, deps);
    expect(first).toMatchObject({ status: 'open', failedStep: 'two', error: 'nope' });

    fail = false;
    const second = await runLinearCase(CASE_ID, plan, deps);
    expect(second.status).toBe('actioned');
    expect(ran).toEqual(['one', 'two', 'two']);
    expect(stepStates(world.row.steps)).toEqual(['one:ok', 'two:failed', 'two:ok']);
    expect(world.alerts).toEqual([{ event: 'actioned', caseId: CASE_ID, category: 'policy' }]);
  });
});
