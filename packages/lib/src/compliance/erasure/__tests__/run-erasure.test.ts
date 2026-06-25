import { describe, it, expect, vi } from 'vitest';
import { runErasure, type RunnableStep, type ErasureRecorder } from '../run-erasure';

function makeRecorder(): ErasureRecorder & { statuses: string[]; steps: unknown[] } {
  const statuses: string[] = [];
  const steps: unknown[] = [];
  return {
    statuses,
    steps,
    updateStatus: vi.fn(async (_id, status) => {
      statuses.push(status);
    }),
    appendStepResult: vi.fn(async (_id, result) => {
      steps.push(result);
    }),
  };
}

const fixedNow = () => new Date('2026-02-01T00:00:00.000Z');

const okStep = (id: string, fatal = false): RunnableStep => ({
  id: id as RunnableStep['id'],
  fatal,
  run: vi.fn(async () => ({ status: 'ok' as const, detail: `${id} done` })),
});

describe('runErasure', () => {
  it('given all steps succeed, should mark in_progress then completed and record every step', async () => {
    const recorder = makeRecorder();
    const result = await runErasure({
      requestId: 'dsr_1',
      attemptsSoFar: 0,
      steps: [okStep('drive-disposition', true), okStep('delete-user', true)],
      recorder,
      now: fixedNow,
    });

    expect(result.status).toBe('completed');
    expect(recorder.statuses[0]).toBe('in_progress');
    expect(recorder.statuses[recorder.statuses.length - 1]).toBe('completed');
    expect(recorder.steps).toHaveLength(2);
  });

  it('given a best-effort step throws, should record the failure but still complete', async () => {
    const recorder = makeRecorder();
    const flaky: RunnableStep = {
      id: 'email-suppression',
      fatal: false,
      run: vi.fn(async () => {
        throw new Error('resend down');
      }),
    };
    const result = await runErasure({
      requestId: 'dsr_1',
      attemptsSoFar: 0,
      steps: [flaky, okStep('delete-user', true)],
      recorder,
      now: fixedNow,
    });

    expect(result.status).toBe('completed');
    const failedStep = (recorder.steps as Array<{ step: string; status: string }>).find(
      (s) => s.step === 'email-suppression'
    );
    expect(failedStep?.status).toBe('failed');
    // The user-deletion step still ran.
    expect((recorder.steps as Array<{ step: string }>).some((s) => s.step === 'delete-user')).toBe(true);
  });

  it('given a fatal step throws a transient error, should mark failed and stop', async () => {
    const recorder = makeRecorder();
    const boom: RunnableStep = {
      id: 'delete-user',
      fatal: true,
      run: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    };
    const never = okStep('stripe-customer', false);
    const result = await runErasure({
      requestId: 'dsr_1',
      attemptsSoFar: 0,
      steps: [boom, never],
      recorder,
      now: fixedNow,
    });

    expect(result.status).toBe('failed');
    expect(result.failedStep).toBe('delete-user');
    expect(recorder.statuses[recorder.statuses.length - 1]).toBe('failed');
    // Steps after a fatal failure do not run.
    expect(never.run).not.toHaveBeenCalled();
  });

  it('given a fatal step throws ERASURE_BLOCKED, should mark blocked with a reason and stop', async () => {
    const recorder = makeRecorder();
    const blocked: RunnableStep = {
      id: 'drive-disposition',
      fatal: true,
      run: vi.fn(async () => {
        throw new Error('ERASURE_BLOCKED: Team Alpha, Team Beta');
      }),
    };
    const result = await runErasure({
      requestId: 'dsr_1',
      attemptsSoFar: 0,
      steps: [blocked, okStep('delete-user', true)],
      recorder,
      now: fixedNow,
    });

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toContain('Team Alpha');
    expect(recorder.statuses[recorder.statuses.length - 1]).toBe('blocked');
  });
});
