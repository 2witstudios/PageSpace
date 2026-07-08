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

/**
 * Normalize a persisted/streamed `commandExecution` payload to a list.
 * Channel/thread rows written before multi-command support shipped still
 * carry a single object (the field was singular then); the jsonb column has
 * no schema migration to rewrite that historical data, so callers must
 * accept either shape. Each item is still validated independently by
 * buildExecutionIndicatorViewModel, so a malformed legacy value degrades to
 * "render nothing for this item" rather than throwing.
 */
export function normalizeCommandExecutionList(data: unknown): unknown[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data;
  return [data];
}

export function buildExecutionIndicatorViewModel(
  data: unknown
): ExecutionIndicatorViewModel | null {
  if (!isCommandExecutionData(data)) return null;

  // Skip labels originate from client-controlled tokens (the grammar admits
  // newlines and near-arbitrary text) — clamp to a single trigger-sized line.
  const label = data.label.split('\n')[0].slice(0, 64);

  if (data.status === 'skipped') {
    const reason: CommandSkipReason = data.reason ?? 'not_found';
    return {
      text: `Skipped /${label} — ${COMMAND_SKIP_REASON_TEXT[reason]}`,
      skipped: true,
    };
  }

  return {
    text: `Using /${label}`,
    skipped: false,
    ...(data.entryPageTitle
      ? { tooltip: `The page “${data.entryPageTitle}” was added to the AI's context for this response.` }
      : {}),
  };
}
