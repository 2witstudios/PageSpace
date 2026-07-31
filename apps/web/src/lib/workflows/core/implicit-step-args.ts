/**
 * Some allowlisted tools require an argument that a deterministic step
 * config must never store itself: `create_page`'s `driveId` must always be
 * the workflow's CURRENT drive, not a value frozen into the step at
 * authoring time (same "recompute at fire time, never trust a stored id"
 * convention as the webhook path's stale-move drive guards). This module is
 * the single place that knows which tools need which implicit args, applied
 * by the shell immediately before validation and before execution — never
 * persisted.
 */

const TOOLS_WITH_IMPLICIT_DRIVE_ID = new Set(['create_page']);

export function applyImplicitStepArgs(
  toolName: string,
  args: Record<string, unknown>,
  driveId: string
): Record<string, unknown> {
  if (!TOOLS_WITH_IMPLICIT_DRIVE_ID.has(toolName)) return args;
  return { ...args, driveId };
}
