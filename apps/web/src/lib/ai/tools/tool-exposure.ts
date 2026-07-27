import type { ToolSet } from 'ai';
import { CORE_TOOL_NAMES } from '../core/stub-tools';
import { TOOL_DISCOVERY_PROMPT, buildNonCoreToolNamesPrompt } from '../core/system-prompt';
import { createToolSearchTool } from './tool-search-tool';
import { createExecuteTool } from './execute-tool';

export type ToolExposureMode = 'upfront' | 'search';

/**
 * Tools added by runtime composer toggles rather than by an agent's saved allowlist,
 * which therefore must stay directly callable instead of being deferred behind
 * execute_tool. Both routes that expose the composer toggles share this set so a new
 * toggle cannot be wired into one and silently forgotten in the other.
 *
 * They break in different ways if deferred, which is why both routes need them upfront:
 * - Page chat (`api/ai/chat`) passes the agent's saved `enabledTools` to execute_tool,
 *   so a toggled-on tool absent from that allowlist is rejected at dispatch.
 * - Global Assistant (`api/ai/global/[id]/messages`) sets no allowlist, but advertises
 *   deferred tools by name in the system prompt without sending their schemas, so the
 *   model calls them directly and the AI SDK rejects them as unknown tools.
 *
 * NOTE: the web-search toggle also gates `web_fetch` (see WEB_SEARCH_TOOLS in
 * core/tool-filtering.ts), which is deliberately NOT listed here — see the PR
 * discussion; promoting it changes page-chat behaviour and belongs in its own change.
 */
export const ALWAYS_UPFRONT_TOOLS: ReadonlySet<string> = new Set(['web_search', 'generate_image']);

/**
 * Split a tool set into the tools handed to the model with full schemas ("core")
 * and the tools deferred behind execute_tool ("non-core").
 *
 * A tool is upfront when it is a core page/drive tool OR is named in
 * `alwaysUpfront`. The latter covers runtime-toggled tools (`web_search`,
 * `generate_image`) which are added independently of an agent's saved allowlist:
 * deferring them behind execute_tool makes them uncallable while their names are
 * still advertised in the system prompt, so the model calls them directly and the
 * AI SDK rejects them as unknown tools.
 *
 * Pure: no prompt assembly, no tool construction. Key order within each half
 * follows the input's key order.
 */
export function splitToolsForExposure(
  tools: ToolSet,
  alwaysUpfront: ReadonlySet<string> = new Set(),
): { coreTools: ToolSet; nonCoreTools: ToolSet } {
  const isUpfront = (name: string) => CORE_TOOL_NAMES.has(name) || alwaysUpfront.has(name);

  const coreTools = Object.fromEntries(
    Object.entries(tools).filter(([name]) => isUpfront(name))
  ) as ToolSet;

  const nonCoreTools = Object.fromEntries(
    Object.entries(tools).filter(([name]) => !isUpfront(name))
  ) as ToolSet;

  return { coreTools, nonCoreTools };
}

/**
 * Drop the always-upfront tools from a tool set, preserving key order.
 *
 * Used for both halves of the exposure decision: the set eligible for deferral, and
 * the catalog tool_search may return. An always-upfront tool must appear in neither —
 * it is already served with a full schema and is deliberately absent from
 * execute_tool's dispatch map, so surfacing it in the catalog would invite a dead-end
 * `execute_tool({tool_name: 'generate_image'})`; TOOL_DISCOVERY_PROMPT instructs the
 * model to run anything it discovers that way. Core tools stay searchable: they are
 * directly callable, so a lookup is harmless.
 */
export function excludeAlwaysUpfront(
  tools: ToolSet,
  alwaysUpfront: ReadonlySet<string> = new Set(),
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !alwaysUpfront.has(name))
  ) as ToolSet;
}

/**
 * Decide how an agent's tools are presented to the model.
 *
 * - `upfront` (default): every tool is handed to the model with its full schema.
 * - `search`: only core tools go upfront; the rest are reached via tool_search /
 *   execute_tool, mirroring the Global Assistant. Keeps context small when many
 *   tools are enabled.
 *
 * The input `tools` is assumed to already be allowlist-filtered, so a blocked tool
 * can never appear in the catalog or the execute_tool dispatch map.
 *
 * `alwaysUpfront` names tools that must stay directly callable even in search mode
 * (and are kept out of the tool_search catalog). This is for runtime overrides such
 * as `web_search`, which is toggled on independently of the saved allowlist —
 * deferring it behind execute_tool would trip that tool's allowlist check and reject
 * it whenever the agent's saved enabledTools omit it.
 *
 * If search mode is requested but there are no non-core tools to defer, the upfront
 * set is returned unchanged (no point adding tool_search/execute_tool scaffolding —
 * or a discovery prompt — when there is nothing to discover).
 */
export function applyToolExposureMode(
  tools: ToolSet,
  mode: ToolExposureMode,
  alwaysUpfront: ReadonlySet<string> = new Set(),
): { tools: ToolSet; toolDiscoveryPrompt: string } {
  if (mode !== 'search') {
    return { tools, toolDiscoveryPrompt: '' };
  }

  // Tools forced upfront (e.g. the web_search runtime override) are excluded from
  // both the deferral split and the searchable catalog.
  const deferrable = excludeAlwaysUpfront(tools, alwaysUpfront);

  // Same predicate as the split's non-core half — derived from it so the rule for
  // "what gets deferred" is defined in exactly one place.
  const { nonCoreTools } = splitToolsForExposure(tools, alwaysUpfront);

  if (Object.keys(nonCoreTools).length === 0) {
    return { tools, toolDiscoveryPrompt: '' };
  }

  const upfrontOverrides = Object.fromEntries(
    Object.entries(tools).filter(([name]) => alwaysUpfront.has(name))
  ) as ToolSet;
  const coreTools = Object.fromEntries(
    Object.entries(deferrable).filter(([name]) => CORE_TOOL_NAMES.has(name))
  ) as ToolSet;

  const searchTools: ToolSet = {
    ...coreTools,
    ...upfrontOverrides,
    tool_search: createToolSearchTool(deferrable),
    execute_tool: createExecuteTool(nonCoreTools),
  };

  const nonCoreNamesPrompt = buildNonCoreToolNamesPrompt(Object.keys(nonCoreTools));
  const toolDiscoveryPrompt = '\n\n' + TOOL_DISCOVERY_PROMPT
    + (nonCoreNamesPrompt ? '\n\n' + nonCoreNamesPrompt : '');

  return { tools: searchTools, toolDiscoveryPrompt };
}
