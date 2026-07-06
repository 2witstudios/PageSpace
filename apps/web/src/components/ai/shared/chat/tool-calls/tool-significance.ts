import { toTitleCase } from '@/lib/utils/formatters';
import { SPECIAL_HANDLED_TOOLS } from './registry';
import { resolveIntegrationToolLabel } from './tool-call-dispatch';
import type { ProcessedToolPart } from '../message-types';

/**
 * Aggregate status of a tool-call run, derived from its members' individual
 * states. Drives the run header's icon/state — the run itself never
 * auto-expands or auto-collapses based on this (see ToolRunGroup.tsx).
 */
export type RunStatus = 'running' | 'error' | 'complete';

/**
 * Tools that always render as their own standalone card and are never folded
 * into a ToolRunGroup, because they show a diff the user needs to review.
 * Referenced by registry-coverage.test.ts (which scans registry.tsx's source
 * for a RichDiffRenderer usage per entry) so this list can't silently drift
 * from the renderers it's meant to describe.
 */
export const DIFF_TOOL_NAMES = new Set(['replace_lines', 'insert_content', 'edit', 'write']);

export function isDiffTool(toolName: string): boolean {
  return DIFF_TOOL_NAMES.has(toolName);
}

/**
 * Tools that always stand alone, breaking any run: diff-producing edits, plus
 * SPECIAL_HANDLED_TOOLS (task tools, ask_agent — registry.tsx's own list of
 * tools rendered as full-width cards outside the generic per-tool registry).
 * Those already get dedicated, information-dense renderers (TaskRenderer,
 * PageAgentConversationRenderer); folding them into a generic "Ran N
 * commands" summary would hide content the user is meant to scan directly.
 */
export function isStandaloneTool(toolName: string): boolean {
  return isDiffTool(toolName) || SPECIAL_HANDLED_TOOLS.has(toolName);
}

/**
 * Tool discovery calls the model makes internally (`tool_search`) that
 * ToolCallRenderer/CompactToolCallRenderer already render as invisible
 * (return null). Shared here so useGroupedParts can skip them the same way
 * it skips FINISH_TOOL_NAME — otherwise a hidden search call could get
 * counted into a ToolRunGroup's summary ("Ran 3 commands (tool_search x1, ...)")
 * or, if a run were entirely searches, collapse into a group that expands to
 * nothing visible.
 */
export const HIDDEN_TOOL_NAMES = new Set(['tool_search']);

export function isHiddenTool(toolName: string): boolean {
  return HIDDEN_TOOL_NAMES.has(toolName);
}

export const safeJsonParse = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
};

/**
 * Resolves the tool actually being invoked, unwrapping the `execute_tool`
 * indirection (its `input.tool_name` carries the real tool name) the same way
 * ToolCallRenderer/CompactToolCallRenderer already unwrap it for display.
 */
export function resolveEffectiveToolName(toolName: string, input: unknown): string {
  if (toolName !== 'execute_tool') return toolName;
  const raw = safeJsonParse(input);
  const innerName = typeof raw?.tool_name === 'string' ? raw.tool_name : null;
  return innerName ?? toolName;
}

/**
 * Shared display-name formatter for the ToolRunGroup summary line. Takes the
 * caller's own name map (main vs compact renderers keep divergent labels) so
 * this doesn't force those two maps to merge, only avoids adding a third copy
 * of the integration-tool lookup + fallback formatting logic (shared via
 * resolveIntegrationToolLabel — the same helper ToolCallRenderer/
 * CompactToolCallRenderer use for their own formattedToolName).
 */
export function getDisplayToolName(toolName: string, nameMap: Record<string, string>): string {
  return resolveIntegrationToolLabel(toolName) || nameMap[toolName] || toTitleCase(toolName);
}

const toRunStatus = (state: ProcessedToolPart['state']): RunStatus => {
  switch (state) {
    case 'output-error':
      return 'error';
    case 'output-available':
    case 'done':
      return 'complete';
    default:
      return 'running';
  }
};

/**
 * Shared run-status aggregation for ToolRunGroup and CompactToolRunGroup:
 * a run is 'error' if any call errored, 'running' if any call is still in
 * flight (and none have errored), otherwise 'complete'.
 */
export function computeToolRunStatus(parts: ProcessedToolPart[]): RunStatus {
  const statuses = parts.map(p => toRunStatus(p.state));
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('running')) return 'running';
  return 'complete';
}

/**
 * Builds the "Ran N commands (bash x3, gh x1)" summary line shared by
 * ToolRunGroup and CompactToolRunGroup, so the format can't drift between the
 * two surfaces.
 */
export function summarizeToolRun(parts: ProcessedToolPart[], nameMap: Record<string, string>): string {
  const counts = new Map<string, number>();
  for (const part of parts) {
    const effectiveName = resolveEffectiveToolName(part.toolName, part.input);
    counts.set(effectiveName, (counts.get(effectiveName) ?? 0) + 1);
  }
  const breakdown = Array.from(counts.entries())
    .map(([name, count]) => `${getDisplayToolName(name, nameMap)} ×${count}`)
    .join(', ');
  return `Ran ${parts.length} commands (${breakdown})`;
}
