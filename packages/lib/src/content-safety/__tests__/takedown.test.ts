import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import type {
  ContentCase,
  ContentCaseSnapshot,
  ContentCaseStep,
} from '@pagespace/db/schema/content-safety';
import { GLOBAL_TAKEDOWN_STEPS, type GlobalTakedownStep } from '../takedown-plan';
import {
  MAX_AUTO_SUSPENSIONS,
  MAX_RESWEEP_ATTEMPTS,
  avatarEvidenceKeyFor,
  avatarTakedownPlan,
  evidenceKeyFor,
  holdKeyFor,
  resweepGlobalTakedown,
  runGlobalTakedown,
  runLinearCase,
  UnpreservedObjectError,
  type ContentReferences,
  type ObjectDigest,
  type TakedownAlert,
  type TakedownDeps,
  type TakedownOriginal,
} from '../takedown';

const ORIGINAL = 'original-bytes';
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const HASH = sha(ORIGINAL);
const CASE_ID = 'case-1';
/** The same number of bytes, different bytes. */
const sameSizeOther = (bytes: string) => (bytes[0] === 'X' ? 'Y' : 'X') + bytes.slice(1);
/** How the fake stores an object encrypted at rest: the content a hash names sits behind the envelope. */
const ENVELOPE = 'ENC:';
const digestOf = (stored: string): ObjectDigest => ({
  size: stored.length,
  sha256: sha(stored),
  contentSha256: sha(stored.startsWith(ENVELOPE) ? stored.slice(ENVELOPE.length) : stored),
});

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

/** In-memory world: two buckets, an evidence bucket, a blocklist and one case. Objects are their bytes. */
function createWorld(options: { category?: ContentCase['category']; evidence?: boolean; snapshot?: ContentCaseSnapshot } = {}) {
  const uploads = new Map<string, string>([
    [`files/${HASH}/original`, ORIGINAL],
    [`cache/${HASH}/thumbnail.webp`, 'thumb'],
  ]);
  const publish = new Map<string, string>([
    [`assets/${HASH}`, ORIGINAL],
    [`assets/cache/${HASH}/thumbnail.webp`, 'thumb'],
  ]);
  const evidence = new Map<string, string>();
  const blocks = new Map<string, { category: string; caseId: string | null }>();
  const alerts: TakedownAlert[] = [];
  const suspended: string[] = [];
  const failNext = new Set<GlobalTakedownStep>();
  const calls: string[] = [];
  const locks = new Set<string>();
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
    /** The evidence copy comes out with the same size and different bytes. */
    corruptCopy: false,
    copies: [] as string[],
    /** Fail the next snapshot write that sets this field. */
    failSnapshotWriteOf: null as string | null,
    /** Called as each storage or store effect starts, before it does anything. */
    onCall: null as null | ((step: GlobalTakedownStep) => Promise<void> | void),
    /** The signal the fake lock hands the run; abort it to lose the lock. */
    lockSignal: new AbortController().signal as AbortSignal | undefined,
    /** Called after a step is recorded on the case. */
    onRecord: null as null | ((step: ContentCaseStep) => void),
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

  const boom = async (step: GlobalTakedownStep) => {
    calls.push(step);
    await world.onCall?.(step);
    if (failNext.delete(step)) throw new Error(`${step} failed`);
  };

  const deps: TakedownDeps = {
    cases: {
      load: async (id) => (id === CASE_ID ? structuredClone(world.row) : null),
      appendStep: async (_id, step) => {
        world.row.steps = [...(world.row.steps ?? []), step];
        world.onRecord?.(step);
      },
      setStatus: async (_id, status) => {
        world.row.status = status;
      },
      mergeSnapshot: async (_id, patch) => {
        if (world.failSnapshotWriteOf && world.failSnapshotWriteOf in patch) {
          world.failSnapshotWriteOf = null;
          throw new Error('snapshot write failed');
        }
        world.row.snapshot = { ...world.row.snapshot, ...patch };
      },
      upsertBlock: async (block) => {
        await boom('block');
        if (!blocks.has(block.contentHash)) blocks.set(block.contentHash, { category: block.category, caseId: block.caseId });
      },
      collectReferences: async () => {
        await boom('record_references');
        return world.references;
      },
      collectAiReferences: async () => {
        await boom('record_ai_references');
        return world.aiReferences;
      },
      withCaseLock: async (id, fn) => {
        if (locks.has(id)) return { acquired: false };
        locks.add(id);
        try {
          return { acquired: true, value: await fn(world.lockSignal) };
        } finally {
          locks.delete(id);
        }
      },
    },
    storage: {
      evidenceConfigured: () => world.evidenceConfigured,
      findOriginals: async (hash, caseId): Promise<TakedownOriginal[]> =>
        [`files/${hash}/original`, `chat-attachments/${hash}/original`, holdKeyFor(caseId, hash)]
          .filter((key) => uploads.has(key))
          .map((key) => ({ key, size: uploads.get(key)!.length })),
      takePublicOffline: async (hash, caseId) => {
        await boom('unpublish_public');
        // The fake mirrors the real rule: the public asset is copied into private storage before its key goes.
        const asset = publish.get(`assets/${hash}`);
        const held = asset !== undefined;
        if (held) uploads.set(holdKeyFor(caseId, hash), asset);
        let deleted = 0;
        for (const key of [...publish.keys()]) if (key.includes(hash) && publish.delete(key)) deleted += 1;
        return { deleted, held };
      },
      digestSource: async (key) => (uploads.has(key) ? digestOf(uploads.get(key)!) : null),
      digestEvidence: async (key) => (evidence.has(key) ? digestOf(evidence.get(key)!) : null),
      copyToEvidence: async (source, key) => {
        await boom('preserve');
        const bytes = uploads.get(source.key)!;
        evidence.set(key, world.corruptCopy ? sameSizeOther(bytes) : bytes);
        world.copies.push(key);
      },
      deleteFromUploads: async (hash, caseId, isPreserved) => {
        await boom('delete_uploads');
        // The fake mirrors the real rule: every private original is checked
        // against what preservation recorded before anything is deleted.
        if (isPreserved) {
          for (const key of [`files/${hash}/original`, `chat-attachments/${hash}/original`, holdKeyFor(caseId, hash)]) {
            const bytes = uploads.get(key);
            if (bytes !== undefined && !isPreserved(digestOf(bytes))) throw new UnpreservedObjectError();
          }
        }
        let deleted = 0;
        for (const key of [...uploads.keys()]) if (key.includes(hash) && uploads.delete(key)) deleted += 1;
        return deleted;
      },
      findDerived: async (hash) =>
        [...uploads.keys()].filter((key) => key.startsWith(`cache/${hash}/`)).map((key) => ({ key, size: uploads.get(key)!.length })),
      listAvatarObjects: async (userId) =>
        [...uploads.keys()].filter((key) => key.startsWith(`avatars/${userId}/`)).map((key) => ({ key, size: uploads.get(key)!.length })),
      deleteFromPublish: async (hash) => {
        await boom('delete_public');
        let deleted = 0;
        for (const key of [...publish.keys()]) if (key.includes(hash) && publish.delete(key)) deleted += 1;
        return deleted;
      },
    },
    suspendUser: async ({ userId }) => {
      await boom('suspend_uploader');
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
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
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

  it('refuses to delete from private storage when the evidence copy has the same size as the source but different bytes', async () => {
    world.corruptCopy = true;
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
    expect(world.uploads.has(`files/${HASH}/original`)).toBe(true);
    expect(world.uploads.size).toBe(3); // the original, its thumbnail and the private copy of the public asset
    expect(world.row.snapshot?.evidenceKey).toBeUndefined();
  });

  it('does not trust an unverified copy left by an earlier attempt: a resume writes it again and verifies', async () => {
    world.corruptCopy = true;
    await runGlobalTakedown(CASE_ID, deps);
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(sameSizeOther(ORIGINAL));

    world.corruptCopy = false;
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.copies).toEqual([evidenceKeyFor(CASE_ID, HASH), evidenceKeyFor(CASE_ID, HASH)]);
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
  });

  it('verifies the copy against the content hash itself, so a copy that verifies is recognised on resume even when recording it failed', async () => {
    world.failSnapshotWriteOf = 'evidenceKey';
    const first = await runGlobalTakedown(CASE_ID, deps);
    expect(first).toMatchObject({ status: 'open', failedStep: 'preserve' });
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
    expect(world.row.snapshot?.evidenceKey).toBeUndefined();

    const second = await runGlobalTakedown(CASE_ID, deps);

    expect(second.status).toBe('actioned');
    // Not written again: the bytes there hash to the content hash, so they ARE the preserved copy.
    expect(world.copies).toEqual([evidenceKeyFor(CASE_ID, HASH)]);
    expect(world.row.snapshot?.evidenceKey).toBe(evidenceKeyFor(CASE_ID, HASH));
    expect(world.row.steps?.filter((s) => s.step === 'preserve').map((s) => s.detail)).toEqual(['snapshot write failed', 'already_preserved']);
  });

  it('recognises that copy even when no source is left to compare it with', async () => {
    world.failSnapshotWriteOf = 'evidenceKey';
    await runGlobalTakedown(CASE_ID, deps);
    world.uploads.clear();

    expect((await runGlobalTakedown(CASE_ID, deps)).status).toBe('actioned');
    expect(world.row.snapshot?.evidenceKey).toBe(evidenceKeyFor(CASE_ID, HASH));
  });

  it('preserves an original stored encrypted at rest, verifying the content behind the envelope', async () => {
    world.uploads.set(`files/${HASH}/original`, `${ENVELOPE}${ORIGINAL}`);
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(`${ENVELOPE}${ORIGINAL}`);
    expect(world.row.snapshot?.evidenceKey).toBe(evidenceKeyFor(CASE_ID, HASH));
  });

  it('keeps bytes at the source that are not the content the hash names apart from the evidence copy, under their own checksum', async () => {
    const other = 'not-what-the-hash-names';
    world.uploads.set(`files/${HASH}/original`, other);
    world.publish.clear();
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    const key = `${evidenceKeyFor(CASE_ID, HASH)}.${sha(other)}`;
    // With no copy of the content itself anywhere, the derived thumbnail is kept as well (it may be all that is left of it).
    const thumbKey = `${evidenceKeyFor(CASE_ID, HASH)}.${sha('thumb')}`;
    expect([...world.evidence.keys()]).toEqual([key, thumbKey]);
    expect(world.evidence.get(key)).toBe(other);
    expect(world.row.snapshot?.evidenceKey).toBeUndefined();
    expect(world.row.snapshot?.additionalEvidenceKeys).toEqual([key, thumbKey]);
  });

  it('preserves the real content wherever it is, when other bytes sit at the page-file key: nothing private is deleted uncopied', async () => {
    // A presigned PUT to files/<hash>/original need not match the hash: junk lands there, the content is a chat attachment.
    const junk = 'junk-written-after-the-block';
    world.uploads.set(`files/${HASH}/original`, junk);
    world.uploads.set(`chat-attachments/${HASH}/original`, ORIGINAL);

    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
    expect(world.row.snapshot?.evidenceKey).toBe(evidenceKeyFor(CASE_ID, HASH));
    expect(world.evidence.get(`${evidenceKeyFor(CASE_ID, HASH)}.${sha(junk)}`)).toBe(junk);
    expect(world.calls.lastIndexOf('preserve')).toBeLessThan(world.calls.indexOf('delete_uploads'));
  });

  it('does not delete when one of several private objects could not be copied', async () => {
    world.uploads.set(`chat-attachments/${HASH}/original`, 'other-bytes');
    let copies = 0;
    const copy = deps.storage.copyToEvidence;
    deps.storage.copyToEvidence = async (source, key) => {
      copies += 1;
      if (copies === 2) throw new Error('copy failed');
      return copy(source, key);
    };

    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
    expect(world.uploads.get(`chat-attachments/${HASH}/original`)).toBe('other-bytes');
    expect(world.calls).not.toContain('delete_uploads');
  });

  describe('bytes that reach a private key after preservation, before the delete', () => {
    const LATE = 'late-upload-bytes';
    /** A presigned PUT issued before the block lands while the delete step starts. */
    const landLate = (key: string, bytes: string) => {
      let landed = false;
      world.onCall = (step) => {
        if (step === 'delete_uploads' && !landed) {
          landed = true;
          world.uploads.set(key, bytes);
        }
      };
    };

    it('fails the delete step, deleting nothing; the next run preserves them, then deletes', async () => {
      landLate(`files/${HASH}/original`, LATE);
      const first = await runGlobalTakedown(CASE_ID, deps);

      expect(first).toMatchObject({ status: 'open', failedStep: 'delete_uploads' });
      expect(world.uploads.get(`files/${HASH}/original`)).toBe(LATE);
      expect(world.uploads.get(`cache/${HASH}/thumbnail.webp`)).toBe('thumb');
      expect(world.calls).not.toContain('delete_public');

      const second = await runGlobalTakedown(CASE_ID, deps);

      expect(second.status).toBe('actioned');
      const lateKey = `${evidenceKeyFor(CASE_ID, HASH)}.${sha(LATE)}`;
      expect(world.evidence.get(lateKey)).toBe(LATE);
      expect(world.row.snapshot?.additionalEvidenceKeys).toContain(lateKey);
      expect(world.uploads.size).toBe(0);
      expect(stepStates(world.row.steps).slice(3)).toEqual([
        'preserve:ok',
        'delete_uploads:failed',
        'preserve:ok',
        'delete_uploads:ok',
        'delete_public:ok',
        'record_ai_references:ok',
      ]);
    });

    it('fails the same way when the hold copy changed after it was preserved', async () => {
      landLate(holdKeyFor(CASE_ID, HASH), LATE);
      const first = await runGlobalTakedown(CASE_ID, deps);

      expect(first).toMatchObject({ failedStep: 'delete_uploads' });
      expect(world.uploads.get(holdKeyFor(CASE_ID, HASH))).toBe(LATE);
      expect((await runGlobalTakedown(CASE_ID, deps)).status).toBe('actioned');
      expect(world.evidence.get(`${evidenceKeyFor(CASE_ID, HASH)}.${sha(LATE)}`)).toBe(LATE);
    });

    it('fails when preservation found nothing and something arrived since', async () => {
      world.uploads.clear();
      world.publish.clear();
      landLate(`files/${HASH}/original`, ORIGINAL);

      expect(await runGlobalTakedown(CASE_ID, deps)).toMatchObject({ failedStep: 'delete_uploads' });
      expect((await runGlobalTakedown(CASE_ID, deps)).status).toBe('actioned');
      expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
      expect(world.uploads.size).toBe(0);
    });

    it('deletes without stopping when the late bytes are the content already preserved, plain or encrypted', async () => {
      landLate(`chat-attachments/${HASH}/original`, `${ENVELOPE}${ORIGINAL}`);
      expect((await runGlobalTakedown(CASE_ID, deps)).status).toBe('actioned');
      expect(world.uploads.size).toBe(0);
      expect(world.copies).toEqual([evidenceKeyFor(CASE_ID, HASH)]);
    });

    it('does not check when an admin skipped preservation for a category that allows it', async () => {
      ({ world, deps } = createWorld({
        category: 'malware',
        snapshot: { takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'known sample' } },
      }));
      landLate(`files/${HASH}/original`, LATE);

      expect((await runGlobalTakedown(CASE_ID, deps)).status).toBe('actioned');
      expect(world.uploads.size).toBe(0);
      expect(world.evidence.size).toBe(0);
    });
  });

  describe('one run at a time', () => {
    it('stops before the next step when the run lock is lost, recording nothing and leaving the status alone', async () => {
      const controller = new AbortController();
      world.lockSignal = controller.signal;
      world.onCall = (step) => {
        if (step === 'record_references') controller.abort();
      };
      world.row.status = 'awaiting_evidence';

      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result).toMatchObject({ failedStep: 'preserve' });
      expect(result.error).toMatch(/lock/);
      expect(world.calls).not.toContain('preserve');
      expect(stepStates(world.row.steps)).toEqual(['block:ok', 'unpublish_public:ok', 'record_references:ok']);
      // Another run may hold the case now; this one must not overwrite what it set.
      expect(world.row.status).toBe('awaiting_evidence');
    });

    it('records no skip once the run lock is lost', async () => {
      ({ world, deps } = createWorld({
        category: 'malware',
        snapshot: { takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'known sample' } },
      }));
      const controller = new AbortController();
      world.lockSignal = controller.signal;
      world.onCall = (step) => {
        if (step === 'record_references') controller.abort();
      };

      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result).toMatchObject({ failedStep: 'preserve' });
      expect(result.error).toMatch(/lock/);
      expect(stepStates(world.row.steps)).toEqual(['block:ok', 'unpublish_public:ok', 'record_references:ok']);
    });

    it('sets no status and sends no alert once the run lock is lost, even when every step is done', async () => {
      const controller = new AbortController();
      world.lockSignal = controller.signal;
      world.onCall = (step) => {
        if (step === 'record_ai_references') controller.abort();
      };

      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result.error).toMatch(/lock/);
      expect(world.row.status).toBe('open');
      expect(world.alerts).toEqual([]);
    });

    it('answers "in progress" to a second run of the same case, which does nothing', async () => {
      let concurrent: Awaited<ReturnType<typeof runGlobalTakedown>> | undefined;
      let callsDuringConcurrent = -1;
      world.onCall = async (step) => {
        if (step !== 'record_references' || concurrent) return;
        const callsBefore = world.calls.length;
        concurrent = await runGlobalTakedown(CASE_ID, deps);
        callsDuringConcurrent = world.calls.length - callsBefore;
      };

      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(concurrent).toEqual({ caseId: CASE_ID, status: 'open', inProgress: true });
      expect(callsDuringConcurrent).toBe(0);
      expect(result.status).toBe('actioned');
      expect(world.copies).toEqual([evidenceKeyFor(CASE_ID, HASH)]);
      expect(world.row.steps?.filter((s) => s.step === 'preserve')).toHaveLength(1);
    });

    it('answers "in progress" to a re-sweep while a run holds the case, and counts no attempt', async () => {
      let concurrent: Awaited<ReturnType<typeof resweepGlobalTakedown>> | undefined;
      world.onCall = async (step) => {
        if (step === 'record_references' && !concurrent) concurrent = await resweepGlobalTakedown(CASE_ID, deps);
      };

      await runGlobalTakedown(CASE_ID, deps);

      expect(concurrent).toMatchObject({ inProgress: true });
      expect(world.row.snapshot?.resweep).toBeUndefined();
      expect(world.row.steps?.some((s) => s.step === 'resweep')).toBe(false);
    });

    it('lets the next run in once the first has finished', async () => {
      world.failNext.add('delete_uploads');
      await runGlobalTakedown(CASE_ID, deps);
      expect((await runGlobalTakedown(CASE_ID, deps)).status).toBe('actioned');
    });
  });

  describe('re-filed as CSAM while a malware run with "skip preservation" is under way', () => {
    const refileAsCsam = () => {
      // What openTakedownCase does to a reused case: the new category, and the skip withdrawn.
      world.row.category = 'csam';
      world.row.snapshot = { ...world.row.snapshot, takedown: { kind: 'global', skipPreservation: false } };
    };

    beforeEach(() => {
      ({ world, deps } = createWorld({
        category: 'malware',
        snapshot: { takedown: { kind: 'global', skipPreservation: true, skipPreservationReason: 'known sample' } },
      }));
    });

    it('preserves, because the category is read again just before preservation is decided', async () => {
      world.onCall = (step) => {
        if (step === 'record_references') refileAsCsam();
      };
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result.status).toBe('actioned');
      expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
      expect(world.calls.indexOf('preserve')).toBeLessThan(world.calls.indexOf('delete_uploads'));
      expect(stepStates(world.row.steps)).not.toContain('preserve:skipped');
    });

    it('preserves after the skip was recorded, because the category is read again before each delete', async () => {
      world.onRecord = (entry) => {
        if (entry.step === 'preserve' && entry.status === 'skipped') refileAsCsam();
      };
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result.status).toBe('actioned');
      expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
      expect(world.calls.filter((c) => c === 'delete_uploads')).toHaveLength(1);
      expect(world.calls.indexOf('preserve')).toBeLessThan(world.calls.indexOf('delete_uploads'));
      expect(stepStates(world.row.steps)).toEqual([
        'block:ok',
        'unpublish_public:ok',
        'record_references:ok',
        'preserve:skipped',
        'preserve:ok',
        'delete_uploads:ok',
        'delete_public:ok',
        'record_ai_references:ok',
      ]);
    });

    it('waits, deleting nothing private, when the re-filed case has no evidence storage', async () => {
      world.evidenceConfigured = false;
      world.onRecord = (entry) => {
        if (entry.step === 'preserve' && entry.status === 'skipped') refileAsCsam();
      };
      const result = await runGlobalTakedown(CASE_ID, deps);

      expect(result).toMatchObject({ status: 'awaiting_evidence', haltReason: 'awaiting_evidence' });
      expect(world.calls).not.toContain('delete_uploads');
      expect(world.uploads.get(`files/${HASH}/original`)).toBe(ORIGINAL);
    });
  });

  it('preserves a public-only file from the private hold copy, then deletes that copy too', async () => {
    world.uploads.clear();
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.row.steps?.find((s) => s.step === 'unpublish_public')?.detail).toContain('held_private_copy');
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
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
    world.evidence.set(evidenceKeyFor(CASE_ID, HASH), 'partial');
    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
  });

  it('stops when the case says a copy was preserved but the evidence object is missing and no source is left', async () => {
    await runGlobalTakedown(CASE_ID, deps);
    // The evidence object disappears; a re-sweep finds no source either.
    world.evidence.clear();
    world.uploads.set(`cache/${HASH}/thumbnail.webp`, 'thumb');

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
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
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
      expect(world.uploads.size).toBe(3); // the original, its thumbnail and the private copy of the public asset
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
      expect(world.uploads.get(holdKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
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
      expect(world.uploads.size).toBe(3); // the original, its thumbnail and the private copy of the public asset
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
      expect(world.uploads.size).toBe(3); // the original, its thumbnail and the private copy of the public asset
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
    world.uploads.set(`files/${HASH}/original`, ORIGINAL);
    const result = await resweepGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
    expect(world.uploads.size).toBe(0);
    expect(world.row.snapshot?.resweep).toEqual({ attempts: 1, done: true });
  });

  it('writes no bookkeeping once the run lock is lost', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    const stepsBefore = world.row.steps?.length;
    const controller = new AbortController();
    controller.abort();
    world.lockSignal = controller.signal;

    const result = await resweepGlobalTakedown(CASE_ID, deps);

    expect(result.error).toMatch(/lock/);
    expect(world.row.steps).toHaveLength(stepsBefore ?? 0);
    expect(world.row.snapshot?.resweep).toBeUndefined();
    expect(world.alerts.map((a) => a.event)).not.toContain('resweep_failed');
  });

  it('does not mark the pass done once the run lock is lost', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    world.uploads.set(`files/${HASH}/original`, ORIGINAL);
    const controller = new AbortController();
    world.lockSignal = controller.signal;
    world.onCall = (step) => {
      if (step === 'delete_public') controller.abort();
    };

    await resweepGlobalTakedown(CASE_ID, deps);

    expect(world.row.snapshot?.resweep).toEqual({ attempts: 1, done: false });
  });

  it('takes a public copy that reappeared off the web before anything else in the pass', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    // A publish in flight at block time put the asset back.
    world.publish.set(`assets/${HASH}`, ORIGINAL);
    const callsBefore = world.calls.length;

    const result = await resweepGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    // No original is left, so the asset is held privately, preserved beside the
    // first copy (same bytes: nothing new to write), and only then deleted.
    expect(world.calls.slice(callsBefore)).toEqual(['unpublish_public', 'delete_uploads', 'delete_public']);
    expect(world.publish.size).toBe(0);
    expect(world.copies).toEqual([evidenceKeyFor(CASE_ID, HASH)]);
    expect(world.uploads.size).toBe(0);
  });

  it('keeps the first preserved copy when the same bytes reappear, and still deletes them', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    world.uploads.set(`files/${HASH}/original`, ORIGINAL);

    await resweepGlobalTakedown(CASE_ID, deps);
    expect(world.copies).toEqual([evidenceKeyFor(CASE_ID, HASH)]);
    expect(world.uploads.size).toBe(0);
  });

  it('never overwrites a verified copy: different bytes of the SAME size are preserved under their own checksum, and both are on the case', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    const first = evidenceKeyFor(CASE_ID, HASH);
    const late = sameSizeOther(ORIGINAL);
    world.uploads.set(`files/${HASH}/original`, late);

    const result = await resweepGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    expect(world.evidence.get(first)).toBe(ORIGINAL);
    expect(world.evidence.get(`${first}.${sha(late)}`)).toBe(late);
    expect(world.row.snapshot?.evidenceKey).toBe(first);
    expect(world.row.snapshot?.additionalEvidenceKeys).toEqual([`${first}.${sha(late)}`]);
    expect(world.uploads.size).toBe(0);
  });

  it('does not delete the late bytes when their own copy cannot be verified', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    world.uploads.set(`files/${HASH}/original`, sameSizeOther(ORIGINAL));
    world.corruptCopy = true;

    const result = await resweepGlobalTakedown(CASE_ID, deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve' });
    expect(world.evidence.get(evidenceKeyFor(CASE_ID, HASH))).toBe(ORIGINAL);
    expect(world.uploads.has(`files/${HASH}/original`)).toBe(true);
  });

  it('alerts when a pass fails, and the next call continues that pass instead of starting another', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    world.uploads.set(`files/${HASH}/original`, ORIGINAL);
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

describe('derived copies when the original is gone', () => {
  it('preserves cache/<hash>/* before deleting it, so a CSAM case never deletes its only remaining bytes unpreserved', async () => {
    const { world, deps } = createWorld();
    world.uploads.delete(`files/${HASH}/original`);
    world.publish.clear();
    let evidenceAtDelete = -1;
    world.onCall = (step) => {
      if (step === 'delete_uploads') evidenceAtDelete = world.evidence.size;
    };

    const result = await runGlobalTakedown(CASE_ID, deps);

    expect(result.status).toBe('actioned');
    const thumbKey = `${evidenceKeyFor(CASE_ID, HASH)}.${sha('thumb')}`;
    expect(world.evidence.get(thumbKey)).toBe('thumb');
    expect(evidenceAtDelete).toBe(1);
    expect(world.row.snapshot?.additionalEvidenceKeys).toContain(thumbKey);
    expect(world.row.steps?.find((s) => s.step === 'preserve')).toMatchObject({ status: 'ok' });
    expect([...world.uploads.keys()]).toEqual([]);
  });

  it('does not copy derived objects when the content itself was preserved', async () => {
    const { world, deps } = createWorld();
    await runGlobalTakedown(CASE_ID, deps);
    expect([...world.evidence.keys()]).toEqual([evidenceKeyFor(CASE_ID, HASH)]);
  });

  it('halts a CSAM case with only derived bytes at awaiting_evidence when there is no evidence storage', async () => {
    const { world, deps } = createWorld({ evidence: false });
    world.uploads.delete(`files/${HASH}/original`);
    const result = await runGlobalTakedown(CASE_ID, deps);
    expect(result).toMatchObject({ status: 'awaiting_evidence' });
    expect(world.uploads.has(`cache/${HASH}/thumbnail.webp`)).toBe(true);
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

describe('avatar takedown plan', () => {
  const USER = 'user-9';
  const AVATAR = 'avatar-bytes';
  const avatarWorld = (category: ContentCase['category'], evidence: boolean) => {
    const created = createWorld({ category, evidence, snapshot: { takedown: { kind: 'avatar' } } });
    created.world.row.targetType = 'avatar';
    created.world.row.targetId = USER;
    created.world.row.contentHash = null;
    created.world.uploads.set(`avatars/${USER}/avatar.png`, AVATAR);
    created.world.uploads.set(`avatars/${USER}/avatar-small.webp`, 'small');
    return created;
  };
  const effects = (world: ReturnType<typeof createWorld>['world']) => ({
    deleteAvatar: async () => {
      for (const key of [...world.uploads.keys()]) if (key.startsWith(`avatars/${USER}/`)) world.uploads.delete(key);
      return 'processor_deleted';
    },
    clearProfileImage: async () => 'cleared',
  });

  it('halts a CSAM avatar case at awaiting_evidence with nothing deleted when there is no evidence storage', async () => {
    const { world, deps } = avatarWorld('csam', false);
    const result = await runLinearCase(CASE_ID, avatarTakedownPlan(world.row, deps, effects(world)), deps);

    expect(result).toMatchObject({ status: 'awaiting_evidence', haltReason: 'awaiting_evidence' });
    expect(world.row.status).toBe('awaiting_evidence');
    expect(world.uploads.get(`avatars/${USER}/avatar.png`)).toBe(AVATAR);
    expect(stepStates(world.row.steps)).toEqual([]);
    expect(world.alerts).toEqual([{ event: 'awaiting_evidence', caseId: CASE_ID, category: 'csam' }]);
  });

  it('copies every avatar object to evidence, verified by checksum, before anything is deleted', async () => {
    const { world, deps } = avatarWorld('csam', true);
    const order: string[] = [];
    const fx = effects(world);
    const result = await runLinearCase(
      CASE_ID,
      avatarTakedownPlan(world.row, deps, {
        deleteAvatar: async () => {
          order.push(`delete with ${world.evidence.size} evidence copies`);
          return fx.deleteAvatar();
        },
        clearProfileImage: fx.clearProfileImage,
      }),
      deps,
    );

    expect(result.status).toBe('actioned');
    expect(order).toEqual(['delete with 2 evidence copies']);
    const big = avatarEvidenceKeyFor(CASE_ID, USER, `avatars/${USER}/avatar.png`, sha(AVATAR));
    expect(big).toBe(`cases/${CASE_ID}/avatar/avatar.png.${sha(AVATAR)}`);
    expect(world.evidence.get(big)).toBe(AVATAR);
    expect(world.row.snapshot?.avatarEvidenceKeys).toHaveLength(2);
    expect(stepStates(world.row.steps)).toEqual(['preserve_avatar:ok', 'delete_avatar:ok', 'clear_profile_image:ok']);
  });

  it('never finishes a CSAM avatar case on an unverified copy: a bad copy stops it before the delete', async () => {
    const { world, deps } = avatarWorld('csam', true);
    world.corruptCopy = true;
    const result = await runLinearCase(CASE_ID, avatarTakedownPlan(world.row, deps, effects(world)), deps);

    expect(result).toMatchObject({ status: 'open', failedStep: 'preserve_avatar' });
    expect(world.uploads.get(`avatars/${USER}/avatar.png`)).toBe(AVATAR);
  });

  it('resumes a halted CSAM case once evidence storage exists, preserving first', async () => {
    const { world, deps } = avatarWorld('csam', false);
    const plan = () => avatarTakedownPlan(world.row, deps, effects(world));
    await runLinearCase(CASE_ID, plan(), deps);
    world.evidenceConfigured = true;
    const result = await runLinearCase(CASE_ID, plan(), deps);

    expect(result.status).toBe('actioned');
    expect(world.evidence.size).toBe(2);
  });

  it('preserves an avatar uploaded after the preserve step, before the delete takes it', async () => {
    const { world, deps } = avatarWorld('csam', true);
    const fx = effects(world);
    let uploadedLate = false;
    const result = await runLinearCase(
      CASE_ID,
      [
        ...avatarTakedownPlan(world.row, deps, {
          deleteAvatar: fx.deleteAvatar,
          clearProfileImage: fx.clearProfileImage,
        }).map((step) =>
          step.step === 'preserve_avatar'
            ? { ...step, run: async () => { const detail = await step.run(); world.uploads.set(`avatars/${USER}/late.png`, 'late'); uploadedLate = true; return detail; } }
            : step,
        ),
      ],
      deps,
    );

    expect(uploadedLate).toBe(true);
    expect(result.status).toBe('actioned');
    expect(world.evidence.get(avatarEvidenceKeyFor(CASE_ID, USER, `avatars/${USER}/late.png`, sha('late')))).toBe('late');
  });

  it('deletes a non-CSAM avatar without evidence storage, recording that nothing was preserved', async () => {
    const { world, deps } = avatarWorld('policy', false);
    const result = await runLinearCase(CASE_ID, avatarTakedownPlan(world.row, deps, effects(world)), deps);

    expect(result.status).toBe('actioned');
    expect(world.row.steps?.[0]).toMatchObject({ step: 'preserve_avatar', status: 'ok', detail: 'no_evidence_storage' });
  });
});
