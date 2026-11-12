import { describe, it, expect, beforeEach } from 'vitest';
import type {
  ContentCase,
  ContentCaseSnapshot,
  ContentCaseStep,
} from '@pagespace/db/schema/content-safety';
import { GLOBAL_TAKEDOWN_STEPS, type GlobalTakedownStep } from '../takedown-plan';
import {
  MAX_AUTO_SUSPENSIONS,
  MAX_RESWEEP_ATTEMPTS,
  evidenceKeyFor,
  holdKeyFor,
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
    aiReferences: { aiMessageIds: [] as string[], conversationIds: [] as string[], uploaderUserIds: [] as string[], truncated: false },
    corruptCopy: false,
    copies: [] as string[],
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
      collectAiReferences: async () => {
        boom('record_ai_references');
        return world.aiReferences;
      },
    },
    storage: {
      evidenceConfigured: () => world.evidenceConfigured,
      findOriginal: async (hash, caseId): Promise<TakedownOriginal | null> => {
        for (const key of [`files/${hash}/original`, holdKeyFor(caseId, hash)]) {
          const size = uploads.get(key);
          if (size !== undefined) return { key, size };
        }
        return null;
      },
      takePublicOffline: async (hash, caseId) => {
        boom('unpublish_public');
        // The fake mirrors the real rule: a public-only file is copied into private storage before its key goes.
        const assetSize = publish.get(`assets/${hash}`);
        const held = assetSize !== undefined && !uploads.has(`files/${hash}/original`);
        if (held) uploads.set(holdKeyFor(caseId, hash), assetSize);
        let deleted = 0;
        for (const key of [...publish.keys()]) if (key.includes(hash) && publish.delete(key)) deleted += 1;
        return { deleted, held };
      },
      headEvidence: async (key) => (evidence.has(key) ? { size: evidence.get(key)! } : null),
      copyToEvidence: async (source, key) => {
        boom('preserve');
        evidence.set(key, world.corruptCopy ? source.size - 1 : source.size);
        world.copies.push(key);
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
      'unpublish_public:ok',
      'record_references:ok',
      'preserve:ok',
      'delete_uploads:ok',
      'delete_public:ok',
      'record_ai_references:ok',
    ]);
    expect(world.suspended).toEqual([]);
  });

  it('takes the public copies off the web before anything is preserved', async () => {
    await runGlobalTakedown(CASE_ID, deps);
    expect(world.calls.slice(0, 4)).toEqual(['block', 'unpublish_public', 'record_references', 'preserve']);
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
    expect(callsBeforeResume[callsBeforeResume.length - 1]).toBe(step);

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

  it('refuses to delete from private storage when the evidence copy does not match the source size', async () => {
    world.corruptCopy = true;
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
    expect(world.uploads.has(`files/${HASH}/original`)).toBe(true);
    expect(world.uploads.size).toBe(2);
    expect(world.row.snapshot?.evidenceKey).toBeUndefined();
  });

  it('does not trust an unverified copy left by an earlier attempt: a resume writes it again and verifies', async () => {
    world.corruptCopy = true;
    await runGlobalTakedown(CASE_ID, deps);
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(1233);

    world.corruptCopy = false;
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.copies).toEqual([evidenceKeyFor(CASE_ID, HASH), evidenceKeyFor(CASE_ID, HASH)]);
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(1234);
  });

  it('preserves a public-only file from the private hold copy, then deletes that copy too', async () => {
    world.uploads.clear();
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.row.steps?.find((s) => s.step === 'unpublish_public')?.detail).toContain('held_private_copy');
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(1234);
    expect(world.publish.size).toBe(0);
    expect(world.uploads.size).toBe(0);
  });

  it('skips preservation when no object exists for the hash at all', async () => {
    world.uploads.clear();
    world.publish.clear();
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(stepStates(world.row.steps)).toContain('preserve:skipped');
    expect(world.blocks.has(HASH)).toBe(true);
  });

  it('refuses to go on when an unverified copy exists and there is no source left to check it against', async () => {
    world.uploads.clear();
    world.publish.clear();
    world.evidence.set(evidenceKeyFor(CASE_ID, HASH), 7);
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
  });

  it('stops when the case says a copy was preserved but the evidence object is missing and no source is left', async () => {
    await runGlobalTakedown(CASE_ID, deps);
    // The evidence object disappears; a re-sweep finds no source either.
    world.evidence.clear();
    world.uploads.set(`cache/${HASH}/thumbnail.webp`, 50);

    const result = await resweepGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
    expect(result.error).toContain('missing');
    expect(world.uploads.has(`cache/${HASH}/thumbnail.webp`)).toBe(true);
    expect(world.alerts.map((a) => a.event)).toContain('resweep_failed');
  });

  it('re-filed as CSAM after a skipped preserve and a failed delete: the resume preserves before it deletes', async () => {
    ({ world, deps } = createWorld({
      category: 'malware',
      snapshot: { takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'known sample' } },
    }));
    world.failNext.add('delete_uploads');
    const first = await runGlobalTakedown(CASE_ID, deps);
    expect(first).toMatchObject({ status: 'open', failedStep: 'delete_uploads' });
    expect(world.evidence.size).toBe(0);

    world.row.category = 'csam'; // what reopening the case with the new category does
    const callsBefore = world.calls.length;
    const second = await runGlobalTakedown(CASE_ID, deps);

    expect(second.status).toBe('actioned');
    expect(world.calls.slice(callsBefore, callsBefore + 2)).toEqual(['preserve', 'delete_uploads']);
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(1234);
  });

  it('re-filed as CSAM with no evidence storage: the resume waits and deletes nothing', async () => {
    ({ world, deps } = createWorld({
      category: 'malware',
      evidence: false,
      snapshot: { takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'known sample' } },
    }));
    world.failNext.add('delete_uploads');
    await runGlobalTakedown(CASE_ID, deps);

    world.row.category = 'csam';
    const second = await runGlobalTakedown(CASE_ID, deps);

    expect(second).toMatchObject({ status: 'awaiting_evidence', haltReason: 'awaiting_evidence' });
    expect(world.uploads.has(`files/${HASH}/original`)).toBe(true);
    expect(world.calls.filter((c) => c === 'delete_uploads')).toHaveLength(1);
  });

  describe('CSAM with no evidence storage', () => {
    beforeEach(() => {
      ({ world, deps } = createWorld({ evidence: false }));
    });

    it('blocks the hash, keeps every private object, and waits', async () => {
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result).toMatchObject({ status: 'awaiting_evidence', haltReason: 'awaiting_evidence' });
      expect(world.blocks.has(HASH)).toBe(true);
      expect(world.uploads.size).toBe(2);
      expect(world.calls).not.toContain('delete_uploads');
      expect(world.row.status).toBe('awaiting_evidence');
    });

    it('still takes the public copies off the web while it waits: nothing stays world-readable', async () => {
      await runGlobalTakedown(CASE_ID, deps);
      expect(world.publish.size).toBe(0);
    });

    it('keeps a public-only file in private storage while it waits, never losing the only copy', async () => {
      world.uploads.clear();
      await runGlobalTakedown(CASE_ID, deps);

      expect(world.publish.size).toBe(0);
      expect(world.uploads.get(holdKeyFor(CASE_ID, HASH))).toBe(1234);
    });

    it('has already recorded who uploaded it, so that survives the uploader deleting their page while the case waits', async () => {
      await runGlobalTakedown(CASE_ID, deps);
      expect(world.row.snapshot?.references?.uploaderUserIds).toEqual(['user-1', 'user-2']);

      // The page is deleted and the orphan reaper removes the rows: nothing references the hash any more.
      world.references = emptyRefs();
      world.evidenceConfigured = true;
      world.row.snapshot = { ...world.row.snapshot, takedown: { kind: 'global', actorUserId: 'admin-1', suspendUploader: true } };
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result.status).toBe('actioned');
      expect(world.row.snapshot?.references?.uploaderUserIds).toEqual(['user-1', 'user-2']);
      expect(world.suspended).toEqual(['user-1', 'user-2']);
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

  describe('content uploaded only through AI chat', () => {
    beforeEach(() => {
      world.references = emptyRefs();
      world.aiReferences = { aiMessageIds: ['msg-1'], conversationIds: ['conv-1'], uploaderUserIds: ['chat-user'], truncated: false };
      world.row.snapshot = { takedown: { kind: 'global', actorUserId: 'admin-1', suspendUploader: true } };
    });

    it('records the AI-chat uploader and suspends them', async () => {
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result.status).toBe('actioned');
      expect(world.row.snapshot?.references).toMatchObject({ aiMessageIds: ['msg-1'], conversationIds: ['conv-1'], uploaderUserIds: ['chat-user'] });
      expect(world.suspended).toEqual(['chat-user']);
    });

    it('does not lose the uploader when the search fails: the case stays open, nobody is skipped, and a resume finishes it', async () => {
      world.failNext.add('record_ai_references');

      const first = await runGlobalTakedown(CASE_ID, deps);
      expect(first).toMatchObject({ status: 'open', failedStep: 'record_ai_references' });
      expect(world.suspended).toEqual([]);
      expect(stepStates(world.row.steps)).not.toContain('suspend_uploader:skipped');
      // The content is already down and deleted: the slow search held nothing up.
      expect(world.uploads.size).toBe(0);
      expect(world.publish.size).toBe(0);

      const second = await runGlobalTakedown(CASE_ID, deps);
      expect(second.status).toBe('actioned');
      expect(world.suspended).toEqual(['chat-user']);
    });

    it('keeps an uploader the early search found even if their message is deleted before the mandatory search runs', async () => {
      // The quick search at record_references finds the chat uploader...
      world.references = { ...emptyRefs(), aiMessageIds: ['msg-1'], conversationIds: ['conv-1'], uploaderUserIds: ['chat-user'] };
      // ...the case then waits at preserve, and meanwhile the message row is hard-deleted.
      world.evidenceConfigured = false;
      await runGlobalTakedown(CASE_ID, deps);
      expect(world.row.status).toBe('awaiting_evidence');
      expect(world.row.snapshot?.references?.uploaderUserIds).toEqual(['chat-user']);

      world.aiReferences = { aiMessageIds: [], conversationIds: [], uploaderUserIds: [], truncated: false };
      world.evidenceConfigured = true;
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result.status).toBe('actioned');
      expect(world.row.snapshot?.references).toMatchObject({ aiMessageIds: ['msg-1'], uploaderUserIds: ['chat-user'] });
      expect(world.suspended).toEqual(['chat-user']);
    });

    it('notes on the step when the quick search did not finish, without failing it', async () => {
      world.references = { ...emptyRefs(), aiMessageScanFailed: true };
      await runGlobalTakedown(CASE_ID, deps);

      const step = world.row.steps?.find((s) => s.step === 'record_references');
      expect(step).toMatchObject({ status: 'ok' });
      expect(step?.detail).toContain('ai_message_search=deferred');
      // The mandatory search then found them, and the stored references carry no stale flag.
      expect(world.row.snapshot?.references?.uploaderUserIds).toEqual(['chat-user']);
      expect(world.row.snapshot?.references?.aiMessageScanFailed).toBeUndefined();
    });

    it('adds to the references recorded earlier instead of replacing them', async () => {
      world.references = { ...emptyRefs(), pageIds: ['page-1'], uploaderUserIds: ['user-1'], conversationIds: ['dm-1'] };
      await runGlobalTakedown(CASE_ID, deps);

      expect(world.row.snapshot?.references).toMatchObject({
        pageIds: ['page-1'],
        uploaderUserIds: ['user-1', 'chat-user'],
        conversationIds: ['dm-1', 'conv-1'],
      });
    });
  });

  it('suspends every recorded uploader except the acting admin', async () => {
    world.row.snapshot = { takedown: { kind: 'global', actorUserId: 'user-2', suspendUploader: true } };
    await runGlobalTakedown(CASE_ID, deps);

    expect(world.suspended).toEqual(['user-1']);
  });

  it('suspends nobody when the hash has more uploaders than one takedown may suspend, and says so on the case', async () => {
    world.row.snapshot = { takedown: { kind: 'global', actorUserId: 'admin-1', suspendUploader: true } };
    world.references = {
      ...world.references,
      uploaderUserIds: Array.from({ length: MAX_AUTO_SUSPENSIONS + 1 }, (_, i) => `user-${i}`),
    };
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.suspended).toEqual([]);
    const step = world.row.steps?.find((s) => s.step === 'suspend_uploader');
    expect(step).toMatchObject({ status: 'skipped' });
    expect(step?.detail).toContain(`too_many_uploaders=${MAX_AUTO_SUSPENSIONS + 1}`);
  });

  it('records, rather than fails, when there is no uploader to suspend', async () => {
    world.row.snapshot = { takedown: { kind: 'global', suspendUploader: true } };
    world.references = { ...world.references, uploaderUserIds: [] };
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(stepStates(world.row.steps)).toContain('suspend_uploader:skipped');
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
    expect(world.row.snapshot?.resweep).toEqual({ attempts: 1, done: true });
  });

  it('keeps the first preserved copy when the same bytes reappear, and still deletes them', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    world.uploads.set(`files/${HASH}/original`, 1234);

    await resweepGlobalTakedown(CASE_ID, deps);
    expect(world.copies).toEqual([evidenceKeyFor(CASE_ID, HASH)]);
    expect(world.uploads.size).toBe(0);
  });

  it('never overwrites a verified copy: different bytes are preserved under their own key, and both are on the case', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    const first = evidenceKeyFor(CASE_ID, HASH);
    world.uploads.set(`files/${HASH}/original`, 4321);

    const result = await resweepGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.evidence.get(first)).toBe(1234);
    expect(world.evidence.get(`${first}.4321`)).toBe(4321);
    expect(world.row.snapshot?.evidenceKey).toBe(first);
    expect(world.row.snapshot?.additionalEvidenceKeys).toEqual([`${first}.4321`]);
    expect(world.uploads.size).toBe(0);
  });

  it('does not delete the late bytes when their own copy cannot be verified', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    world.uploads.set(`files/${HASH}/original`, 4321);
    world.corruptCopy = true;

    const result = await resweepGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(1234);
    expect(world.uploads.has(`files/${HASH}/original`)).toBe(true);
  });

  it('alerts when a pass fails, and the next call continues that pass instead of starting another', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    world.uploads.set(`files/${HASH}/original`, 1234);
    world.failNext.add('delete_uploads');

    const failed = await resweepGlobalTakedown(CASE_ID, deps);
    expect(failed).toMatchObject({ status: 'open', failedStep: 'delete_uploads' });
    expect(world.alerts[world.alerts.length - 1]).toEqual({ event: 'resweep_failed', caseId: CASE_ID, category: 'csam', attempt: 1 });
    expect(world.row.snapshot?.resweep).toEqual({ attempts: 1, done: false });

    const retried = await resweepGlobalTakedown(CASE_ID, deps);
    expect(retried.status).toBe('actioned');
    expect(world.row.snapshot?.resweep).toEqual({ attempts: 2, done: true });
    expect(world.row.steps?.filter((s) => s.step === 'resweep')).toHaveLength(1);
    expect(world.uploads.size).toBe(0);
  });

  it('counts every failed attempt so a caller can stop at the cap', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    for (let attempt = 1; attempt <= MAX_RESWEEP_ATTEMPTS; attempt += 1) {
      world.failNext.add('delete_uploads');
      await resweepGlobalTakedown(CASE_ID, deps);
    }

    expect(world.row.snapshot?.resweep).toEqual({ attempts: MAX_RESWEEP_ATTEMPTS, done: false });
    expect(world.alerts.filter((a) => a.event === 'resweep_failed').map((a) => a.attempt)).toEqual([1, 2, 3]);
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
