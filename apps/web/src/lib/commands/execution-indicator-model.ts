/**
 * Pure render model for the command execution indicator (UX spec §7):
 * the "Using /foo" pill above a streaming response and the
 * "Skipped /foo — {reason}" notice, persisted on the message.
 *
 * The payload arrives as an untyped `data-command-execution` message part
 * (streamed live or reconstructed from persistence), so this validates the
 * shape instead of trusting it.
 */

import {
  COMMAND_SKIP_REASON_TEXT,
  type CommandSkipReason,
  type CommandExecutionData,
} from '@/lib/ai/core/command-processor';

export interface ExecutionIndicatorViewModel {
  /** Pill text: "Using /foo" or the full skip notice. */
  text: string;
  skipped: boolean;
  /** §7.1 persistent-indicator tooltip (used commands with an entry page). */
  tooltip?: string;
}

const SKIP_REASONS = new Set<string>(Object.keys(COMMAND_SKIP_REASON_TEXT));

function isCommandExecutionData(value: unknown): value is CommandExecutionData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.label !== 'string' || candidate.label.length === 0) return false;
  if (candidate.status !== 'used' && candidate.status !== 'skipped') return false;
  if (candidate.reason !== undefined && !SKIP_REASONS.has(candidate.reason as string)) return false;
  if (candidate.entryPageTitle !== undefined && typeof candidate.entryPageTitle !== 'string') return false;
  return true;
}

export function buildExecutionIndicatorViewModel(
  data: unknown
): ExecutionIndicatorViewModel | null {
  if (!isCommandExecutionData(data)) return null;

  if (data.status === 'skipped') {
    const reason: CommandSkipReason = data.reason ?? 'not_found';
    return {
      text: `Skipped /${data.label} — ${COMMAND_SKIP_REASON_TEXT[reason]}`,
      skipped: true,
    };
  }

  return {
    text: `Using /${data.label}`,
    skipped: false,
    ...(data.entryPageTitle
      ? { tooltip: `The page “${data.entryPageTitle}” was added to the AI's context for this response.` }
      : {}),
  };
}
