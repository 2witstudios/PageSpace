import { describe, it, expect } from 'vitest';
import type { ContentCaseStep } from '@pagespace/db/schema/content-safety';
import {
  GLOBAL_TAKEDOWN_STEPS,
  RESWEEP_MARKER,
  UNPRESERVED_OBJECT,
  describeCaseProgress,
  nextGlobalTakedownStep,
  statusForDecision,
  summarizeSteps,
  type GlobalTakedownPlanInput,
  type GlobalTakedownStep,
} from '../takedown-plan';

const at = '2026-11-12T00:00:00.000Z';
const ok = (step: string): ContentCaseStep => ({ step, status: 'ok', at });
const failed = (step: string): ContentCaseStep => ({ step, status: 'failed', detail: 'boom', at });
const skipped = (step: string): ContentCaseStep => ({ step, status: 'skipped', at });

const input = (overrides: Partial<GlobalTakedownPlanInput> = {}): GlobalTakedownPlanInput => ({
  steps: [],
  category: 'csam',
  evidenceConfigured: true,
  skipPreservation: false,
  suspendUploader: false,
  ...overrides,
});

describe('nextGlobalTakedownStep', () => {
  it('blocks the hash before anything else', () => {
    expect(nextGlobalTakedownStep(input())).toEqual({ kind: 'run', step: 'block' });
  });

  it('walks block, unpublish, record references, preserve, both deletes, then the AI-message search, in order', () => {
    const steps: ContentCaseStep[] = [];
    const order: GlobalTakedownStep[] = [];
    for (;;) {
      const decision = nextGlobalTakedownStep(input({ steps }));
      if (decision.kind !== 'run') {
        expect(decision).toEqual({ kind: 'done' });
        break;
      }
      order.push(decision.step);
      steps.push(ok(decision.step));
    }
    expect(order).toEqual(['block', 'unpublish_public', 'record_references', 'preserve', 'delete_uploads', 'delete_public', 'record_ai_references']);
  });

  it('adds the suspension as the last step only when asked for', () => {
    const steps = GLOBAL_TAKEDOWN_STEPS.filter((s) => s !== 'suspend_uploader').map(ok);
    expect(nextGlobalTakedownStep(input({ steps }))).toEqual({ kind: 'done' });
    expect(nextGlobalTakedownStep(input({ steps, suspendUploader: true }))).toEqual({
      kind: 'run',
      step: 'suspend_uploader',
    });
  });

  it.each(GLOBAL_TAKEDOWN_STEPS)('reruns %s when its last attempt failed, and nothing before it', (step) => {
    const before = GLOBAL_TAKEDOWN_STEPS.slice(0, GLOBAL_TAKEDOWN_STEPS.indexOf(step)).map(ok);
    const decision = nextGlobalTakedownStep(input({ steps: [...before, failed(step)], suspendUploader: true }));
    expect(decision).toEqual({ kind: 'run', step });
  });

  it('moves past a step whose retry succeeded after a failure', () => {
    const steps = [ok('block'), ok('unpublish_public'), ok('record_references'), failed('preserve'), ok('preserve')];
    expect(nextGlobalTakedownStep(input({ steps }))).toEqual({ kind: 'run', step: 'delete_uploads' });
  });

  it('treats a skipped step as settled', () => {
    const steps = [ok('block'), ok('unpublish_public'), ok('record_references'), skipped('preserve')];
    expect(nextGlobalTakedownStep(input({ steps }))).toEqual({ kind: 'run', step: 'delete_uploads' });
  });

  describe('preservation', () => {
    const blocked = [ok('block'), ok('unpublish_public'), ok('record_references')];

    it('takes the public copies offline straight after the block, before anything that reads the database', () => {
      expect(nextGlobalTakedownStep(input({ steps: [ok('block')], evidenceConfigured: false }))).toEqual({
        kind: 'run',
        step: 'unpublish_public',
      });
    });

    it('records references before a CSAM case can halt for evidence storage', () => {
      expect(nextGlobalTakedownStep(input({ steps: [ok('block'), ok('unpublish_public')], evidenceConfigured: false }))).toEqual({
        kind: 'run',
        step: 'record_references',
      });
    });

    it('halts a CSAM case that has no evidence storage, before any delete', () => {
      expect(nextGlobalTakedownStep(input({ steps: blocked, evidenceConfigured: false }))).toEqual({
        kind: 'halt',
        reason: 'awaiting_evidence',
      });
    });

    it('never lets skipPreservation apply to CSAM', () => {
      expect(
        nextGlobalTakedownStep(input({ steps: blocked, evidenceConfigured: false, skipPreservation: true })),
      ).toEqual({ kind: 'halt', reason: 'awaiting_evidence' });
      expect(
        nextGlobalTakedownStep(input({ steps: blocked, evidenceConfigured: true, skipPreservation: true })),
      ).toEqual({ kind: 'run', step: 'preserve' });
    });

    it('resumes a halted CSAM case once evidence storage is configured', () => {
      expect(nextGlobalTakedownStep(input({ steps: blocked, evidenceConfigured: true }))).toEqual({
        kind: 'run',
        step: 'preserve',
      });
    });

    it.each(['malware', 'illegal_other'] as const)('skips preservation for %s when the admin says so', (category) => {
      expect(nextGlobalTakedownStep(input({ steps: blocked, category, skipPreservation: true }))).toEqual({
        kind: 'skip',
        step: 'preserve',
        detail: 'skipped_by_admin',
      });
    });

    it('asks for a decision when a non-CSAM case has no evidence storage and no skip', () => {
      expect(
        nextGlobalTakedownStep(input({ steps: blocked, category: 'malware', evidenceConfigured: false })),
      ).toEqual({ kind: 'halt', reason: 'preservation_decision_required' });
    });
  });

  describe('a delete that found an object preservation did not copy', () => {
    const upToDelete = ['block', 'unpublish_public', 'record_references', 'preserve'].map(ok);
    const unpreserved: ContentCaseStep = { step: 'delete_uploads', status: 'failed', detail: `${UNPRESERVED_OBJECT}: x`, at };

    it('goes back to preservation, not straight to the delete again', () => {
      expect(nextGlobalTakedownStep(input({ steps: [...upToDelete, unpreserved] }))).toEqual({ kind: 'run', step: 'preserve' });
    });

    it('retries the delete once preservation has run again', () => {
      expect(nextGlobalTakedownStep(input({ steps: [...upToDelete, unpreserved, ok('preserve')] }))).toEqual({ kind: 'run', step: 'delete_uploads' });
    });

    it('retries only the delete after any other delete failure', () => {
      expect(nextGlobalTakedownStep(input({ steps: [...upToDelete, failed('delete_uploads')] }))).toEqual({ kind: 'run', step: 'delete_uploads' });
    });

    it('goes back to preservation within a re-sweep too', () => {
      const finished = ['block', 'unpublish_public', 'record_references', 'preserve', 'delete_uploads', 'delete_public', 'record_ai_references'].map(ok);
      const steps = [...finished, ok(RESWEEP_MARKER), ok('unpublish_public'), ok('preserve'), unpreserved];
      expect(nextGlobalTakedownStep(input({ steps }))).toEqual({ kind: 'run', step: 'preserve' });
    });
  });

  it('does not finish a case, or suspend anyone, until the AI-message search has succeeded', () => {
    const steps = ['block', 'unpublish_public', 'record_references', 'preserve', 'delete_uploads', 'delete_public'].map(ok);
    expect(nextGlobalTakedownStep(input({ steps, suspendUploader: true }))).toEqual({ kind: 'run', step: 'record_ai_references' });
    expect(nextGlobalTakedownStep(input({ steps: [...steps, failed('record_ai_references')], suspendUploader: true }))).toEqual({
      kind: 'run',
      step: 'record_ai_references',
    });
  });

  it('keeps the slow AI-message search out of the way of taking content down and deleting it', () => {
    const order = [...GLOBAL_TAKEDOWN_STEPS];
    expect(order.indexOf('record_ai_references')).toBeGreaterThan(order.indexOf('delete_public'));
    expect(order.indexOf('record_ai_references')).toBeLessThan(order.indexOf('suspend_uploader'));
  });

  describe('a case re-filed under a different category', () => {
    // Malware, admin skipped preservation, the run failed at delete_uploads — then the hash is re-filed as CSAM.
    const refiled = [ok('block'), ok('unpublish_public'), ok('record_references'), { ...skipped('preserve'), detail: 'skipped_by_admin' }, failed('delete_uploads')];

    it('resumes at preserve, not at the deletes: a skip granted under malware is void under CSAM', () => {
      expect(nextGlobalTakedownStep(input({ steps: refiled, category: 'csam', skipPreservation: true }))).toEqual({
        kind: 'run',
        step: 'preserve',
      });
    });

    it('waits for evidence storage when there is none, deleting nothing', () => {
      expect(
        nextGlobalTakedownStep(input({ steps: refiled, category: 'csam', skipPreservation: true, evidenceConfigured: false })),
      ).toEqual({ kind: 'halt', reason: 'awaiting_evidence' });
    });

    it('still honours the skip while the category permits it', () => {
      expect(nextGlobalTakedownStep(input({ steps: refiled, category: 'malware', skipPreservation: true }))).toEqual({
        kind: 'run',
        step: 'delete_uploads',
      });
    });

    it('voids the skip when the admin option is withdrawn, too', () => {
      expect(nextGlobalTakedownStep(input({ steps: refiled, category: 'malware', skipPreservation: false }))).toEqual({
        kind: 'run',
        step: 'preserve',
      });
    });

    it('does not re-open a preserve that was skipped because there was nothing to preserve', () => {
      const steps = [ok('block'), ok('unpublish_public'), ok('record_references'), { ...skipped('preserve'), detail: 'no_source_object' }, failed('delete_uploads')];
      expect(nextGlobalTakedownStep(input({ steps, category: 'csam' }))).toEqual({ kind: 'run', step: 'delete_uploads' });
    });
  });

  describe('re-sweep', () => {
    const finished = ['block', 'unpublish_public', 'record_references', 'preserve', 'delete_uploads', 'delete_public', 'record_ai_references'].map(ok);

    it('takes the public copies off the web again before anything else, then repeats preserve and both deletes, and nothing else', () => {
      const steps = [...finished, ok(RESWEEP_MARKER)];
      const order: string[] = [];
      for (;;) {
        const decision = nextGlobalTakedownStep(input({ steps }));
        if (decision.kind !== 'run') break;
        order.push(decision.step);
        steps.push(ok(decision.step));
      }
      // A publish in flight when the hash was blocked can have put a public copy back.
      expect(order).toEqual(['unpublish_public', 'preserve', 'delete_uploads', 'delete_public']);
    });

    it('still halts a CSAM re-sweep that has no evidence storage, once the public copies are off again', () => {
      const steps = [...finished, ok(RESWEEP_MARKER), ok('unpublish_public')];
      expect(nextGlobalTakedownStep(input({ steps, evidenceConfigured: false }))).toEqual({
        kind: 'halt',
        reason: 'awaiting_evidence',
      });
    });
  });
});

describe('statusForDecision', () => {
  it('maps each decision to the case status it leaves behind', () => {
    expect(statusForDecision({ kind: 'done' })).toBe('actioned');
    expect(statusForDecision({ kind: 'halt', reason: 'awaiting_evidence' })).toBe('awaiting_evidence');
    expect(statusForDecision({ kind: 'halt', reason: 'preservation_decision_required' })).toBe('open');
    expect(statusForDecision({ kind: 'run', step: 'block' })).toBe('open');
  });
});

describe('summarizeSteps', () => {
  it('reports the latest state of each step in plan order, pending when never run', () => {
    const steps = [ok('block'), ok('unpublish_public'), ok('record_references'), failed('preserve'), ok('preserve'), failed('delete_uploads')];
    expect(summarizeSteps(steps, GLOBAL_TAKEDOWN_STEPS)).toEqual([
      { step: 'block', status: 'ok' },
      { step: 'unpublish_public', status: 'ok' },
      { step: 'record_references', status: 'ok' },
      { step: 'preserve', status: 'ok' },
      { step: 'delete_uploads', status: 'failed', detail: 'boom' },
      { step: 'delete_public', status: 'pending' },
      { step: 'record_ai_references', status: 'pending' },
      { step: 'suspend_uploader', status: 'pending' },
    ]);
  });
});

describe('describeCaseProgress', () => {
  it('shows a global case part-way through as resumable, without the suspension it was not asked for', () => {
    const progress = describeCaseProgress({
      status: 'open',
      steps: [ok('block'), ok('unpublish_public'), ok('record_references'), ok('preserve'), failed('delete_uploads')],
      snapshot: { takedown: { kind: 'global' } },
    });

    expect(progress.kind).toBe('global');
    expect(progress.resumable).toBe(true);
    expect(progress.resweepable).toBe(false);
    expect(progress.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      'block:ok',
      'unpublish_public:ok',
      'record_references:ok',
      'preserve:ok',
      'delete_uploads:failed',
      'delete_public:pending',
      'record_ai_references:pending',
    ]);
  });

  it('includes the suspension step when the case asked for it', () => {
    const progress = describeCaseProgress({ status: 'open', steps: [], snapshot: { takedown: { kind: 'global', suspendUploader: true } } });
    expect(progress.steps[progress.steps.length - 1]).toEqual({ step: 'suspend_uploader', status: 'pending' });
  });

  it('shows a case waiting for evidence storage as resumable', () => {
    const progress = describeCaseProgress({ status: 'awaiting_evidence', steps: [ok('block')], snapshot: { takedown: { kind: 'global' } } });
    expect(progress.resumable).toBe(true);
  });

  it('offers a re-sweep, not a resume, for a finished global case', () => {
    const progress = describeCaseProgress({ status: 'actioned', steps: [], snapshot: { takedown: { kind: 'global' } } });
    expect(progress).toMatchObject({ resumable: false, resweepable: true, restorable: false });
  });

  it('uses the avatar plan for an avatar case', () => {
    const progress = describeCaseProgress({ status: 'open', steps: [ok('preserve_avatar'), ok('delete_avatar')], snapshot: { takedown: { kind: 'avatar' } } });
    expect(progress.steps).toEqual([
      { step: 'preserve_avatar', status: 'ok' },
      { step: 'delete_avatar', status: 'ok' },
      { step: 'clear_profile_image', status: 'pending' },
    ]);
  });

  it('has nothing to resume for a case that is only a report', () => {
    expect(describeCaseProgress({ status: 'open', steps: null, snapshot: null })).toEqual({
      kind: null,
      steps: [],
      resumable: false,
      resweepable: false,
      restorable: false,
    });
  });

  it('offers a re-sweep for a case left open by a failed re-sweep', () => {
    const progress = describeCaseProgress({
      status: 'open',
      steps: [],
      snapshot: { takedown: { kind: 'global' }, resweep: { attempts: 1, done: false } },
    });
    expect(progress).toMatchObject({ resumable: true, resweepable: true });
  });

  it('offers to lift a drive-parking hold once, and shows the restore after it', () => {
    const parked = describeCaseProgress({ status: 'actioned', steps: [ok('park_sites')], snapshot: { takedown: { kind: 'park_drive' } } });
    expect(parked.restorable).toBe(true);

    const restored = describeCaseProgress({
      status: 'actioned',
      steps: [ok('park_sites'), ok('restore_sites')],
      snapshot: { takedown: { kind: 'park_drive' } },
    });
    expect(restored.restorable).toBe(false);
    expect(restored.steps.map((s) => s.step)).toEqual(['park_sites', 'restore_sites']);
  });
});
