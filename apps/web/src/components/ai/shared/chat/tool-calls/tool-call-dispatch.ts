/**
 * Shared tool-call dispatch logic, used identically by ToolCallRenderer and
 * CompactToolCallRenderer to decide which component should render a given
 * tool part before either reaches its own (surface-specific) generic
 * rendering path.
 */

import { isHiddenTool } from './tool-significance';
import { isIntegrationTool, parseIntegrationToolName } from '@pagespace/lib/integrations/converter/ai-sdk';
import { getBuiltinProvider } from '@pagespace/lib/integrations/providers/builtin-providers';

export interface DispatchToolPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export type ToolCallDispatchResult<TPart extends DispatchToolPart> =
  | { kind: 'hidden' }
  | { kind: 'task'; part: TPart }
  | { kind: 'agent'; part: TPart }
  | { kind: 'generic'; part: TPart; toolName: string };

const safeJsonParse = (value: unknown): Record<string, unknown> | null => {
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
 * Resolves which renderer a tool part should go through: hidden (tool
 * discovery calls like tool_search), a task tool, ask_agent, or the generic
 * per-surface renderer. Unwraps the execute_tool indirection first (its
 * `input.tool_name` carries the real tool name), matching what both
 * ToolCallRenderer and CompactToolCallRenderer already did independently.
 */
export function dispatchToolCall<TPart extends DispatchToolPart>(
  part: TPart,
  taskToolNames: Set<string>
): ToolCallDispatchResult<TPart> {
  let toolName = part.toolName || part.type?.replace('tool-', '') || 'unknown_tool';
  let resolvedPart: TPart = part;

  if (isHiddenTool(toolName)) return { kind: 'hidden' };

  if (toolName === 'execute_tool') {
    const raw = safeJsonParse(part.input);
    const innerName = typeof raw?.tool_name === 'string' ? raw.tool_name : null;
    if (innerName) {
      toolName = innerName;
      resolvedPart = { ...part, input: raw?.parameters ?? {} };
    }
  }

  if (isHiddenTool(toolName)) return { kind: 'hidden' };

  if (taskToolNames.has(toolName)) return { kind: 'task', part: resolvedPart };
  if (toolName === 'ask_agent') return { kind: 'agent', part: resolvedPart };
  return { kind: 'generic', part: resolvedPart, toolName };
}

/**
 * Resolves the display label for an integration tool (e.g. a GitHub/Slack
 * action wired through the integrations converter), or null if `toolName`
 * isn't an integration tool — callers fall back to their own TOOL_NAME_MAP
 * lookup in that case. Identical logic previously lived in both
 * ToolCallRenderer's and CompactToolCallRenderer's formattedToolName.
 */
export function resolveIntegrationToolLabel(toolName: string): string | null {
  if (!isIntegrationTool(toolName)) return null;
  const parsed = parseIntegrationToolName(toolName);
  if (!parsed) return null;
  const provider = getBuiltinProvider(parsed.providerSlug);
  const tool = provider?.tools.find(t => t.id === parsed.toolId);
  if (tool) return tool.name;
  return parsed.toolId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
