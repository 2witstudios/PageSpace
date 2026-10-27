import { broadcastRepository } from '@pagespace/lib/repositories/broadcast-repository';
import type { BroadcastStepResult } from '@pagespace/db/schema/email-broadcasts';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Append to a broadcast's progress trail WITHOUT letting the append fail the
 * request. Admin routes record step notes as UI-facing evidence — the durable
 * who/why record is the auditRequest entry — and a 500 thrown for a failed
 * note would misreport an intervention or enqueue that DID land, inviting the
 * retry these routes exist to prevent.
 *
 * Deliberately NOT how the worker writes step results: there, a throw is
 * wanted, because pg-boss retries the job. The swallow-and-warn policy is an
 * admin-route decision, named once here so the routes cannot drift apart.
 */
export async function appendStepResultBestEffort(
  broadcastId: string,
  entry: BroadcastStepResult,
): Promise<void> {
  try {
    await broadcastRepository.appendStepResult(broadcastId, entry);
  } catch (error) {
    loggers.api.warn('Broadcast step-result append failed', {
      broadcastId,
      step: entry.step,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
