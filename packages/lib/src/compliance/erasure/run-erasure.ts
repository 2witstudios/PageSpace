/**
 * Erasure runner — executes an ordered list of pre-wired steps and records the
 * outcome on the Data Subject Request row.
 *
 * Dependency-injected: the caller (the web execute endpoint) supplies each
 * step's `run` closure and a recorder seam, so this orchestration is fully unit
 * testable with no real DB. Business decisions (which steps, fatal vs
 * best-effort, blocked vs retryable) come from `erasure-plan`.
 */

import type { ErasureStepId } from './erasure-plan';
import { classifyErasureError } from './erasure-plan';
import type { DataSubjectRequestStatus, DataSubjectRequestStepResult } from '@pagespace/db/schema/data-subject-requests';

export interface StepOutcome {
  status: 'ok' | 'skipped';
  detail?: string;
}

export interface RunnableStep {
  id: ErasureStepId;
  fatal: boolean;
  run: () => Promise<StepOutcome>;
}

/** Persistence seam — the DSR repository in production, a fake in tests. */
export interface ErasureRecorder {
  updateStatus: (
    id: string,
    status: DataSubjectRequestStatus,
    patch?: { startedAt?: Date; completedAt?: Date; blockedReason?: string | null; lastError?: string | null }
  ) => Promise<void>;
  appendStepResult: (id: string, result: DataSubjectRequestStepResult) => Promise<void>;
}

export interface RunErasureArgs {
  requestId: string;
  steps: RunnableStep[];
  attemptsSoFar: number;
  recorder: ErasureRecorder;
  now: () => Date;
}

export interface RunErasureResult {
  status: 'completed' | 'failed' | 'blocked';
  failedStep?: ErasureStepId;
  error?: string;
  blockedReason?: string;
}

export async function runErasure(args: RunErasureArgs): Promise<RunErasureResult> {
  const { requestId, steps, recorder, now } = args;

  await recorder.updateStatus(requestId, 'in_progress', { startedAt: now() });

  for (const step of steps) {
    try {
      const outcome = await step.run();
      await recorder.appendStepResult(requestId, {
        step: step.id,
        status: outcome.status,
        detail: outcome.detail,
        at: now().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recorder.appendStepResult(requestId, {
        step: step.id,
        status: 'failed',
        detail: message,
        at: now().toISOString(),
      });

      if (!step.fatal) {
        // Best-effort sub-processor propagation — record and carry on. Erasure
        // of the data subject cannot be gated on a third party's availability.
        continue;
      }

      const classification = classifyErasureError(error);
      if (classification.terminalReason === 'blocked') {
        await recorder.updateStatus(requestId, 'blocked', { blockedReason: message });
        return { status: 'blocked', failedStep: step.id, blockedReason: message };
      }

      await recorder.updateStatus(requestId, 'failed', { lastError: message });
      return { status: 'failed', failedStep: step.id, error: message };
    }
  }

  await recorder.updateStatus(requestId, 'completed', { completedAt: now() });
  return { status: 'completed' };
}
