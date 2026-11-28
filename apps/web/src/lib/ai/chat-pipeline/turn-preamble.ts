import {
  COMMAND_EXECUTION_PART_TYPE,
  commandExecutionDataFromPlan,
  type CommandExecutionData,
  type CommandExecutionPlan,
} from '@/lib/ai/core/command-processor';
import { spendFallbackPart, type SpendFallbackPart, type TurnCredit } from './turn-credit';

/** The parts a turn writes before the model runs. */
type PreamblePart =
  | SpendFallbackPart
  | { type: typeof COMMAND_EXECUTION_PART_TYPE; id: string; data: CommandExecutionData };

/** The slice of the UI message stream writer the preamble uses. */
export interface PreambleWriter {
  write(part: PreamblePart): void;
}

/**
 * What the page and the global chat turn both write first, before the model runs:
 *   1. SPEND-4: when the drive's rule moved the turn to another source, a
 *      `data-spend-fallback` part naming both sources (the gate never switches silently);
 *   2. execution feedback (UX spec §7): one command indicator per resolved plan
 *      ("Using /foo" / "Skipped /foo — reason"), in the order the chips appeared in the
 *      user's message, persisted with the message via onFinish.
 * One definition, so the two turn strategies cannot drift (turn-duplication ratchet).
 */
export function writeTurnPreamble(
  writer: PreambleWriter,
  input: { messageId: string; credit: TurnCredit; commandPlans: readonly CommandExecutionPlan[] },
): void {
  const fallback = spendFallbackPart(input.credit, input.messageId);
  if (fallback) writer.write(fallback);
  input.commandPlans.forEach((plan, index) => {
    writer.write({
      type: COMMAND_EXECUTION_PART_TYPE,
      id: `${input.messageId}-command-${index}`,
      data: commandExecutionDataFromPlan(plan),
    });
  });
}
