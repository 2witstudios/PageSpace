import { parseIntegrationToolName, isIntegrationTool } from '@pagespace/lib/integrations/converter/ai-sdk';
import { getBuiltinProvider } from '@pagespace/lib/integrations/providers/builtin-providers';
import { toTitleCase } from '@/lib/utils/formatters';
import { SPECIAL_HANDLED_TOOLS } from './registry';
import type { ProcessedToolPart } from '../message-types';

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
 * of the integration-tool lookup + fallback formatting logic.
 */
export function getDisplayToolName(toolName: string, nameMap: Record<string, string>): string {
  if (isIntegrationTool(toolName)) {
    const parsed = parseIntegrationToolName(toolName);
    if (parsed) {
      const provider = getBuiltinProvider(parsed.providerSlug);
      const tool = provider?.tools.find(t => t.id === parsed.toolId);
      if (tool) return tool.name;
      return toTitleCase(parsed.toolId);
    }
  }
  return nameMap[toolName] || toTitleCase(toolName);
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
