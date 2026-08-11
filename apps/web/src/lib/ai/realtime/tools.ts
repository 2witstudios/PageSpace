/**
 * PageSpace's AI SDK tool registry, projected onto the realtime wire shape.
 *
 * Voice is a second transport onto the conversations PageSpace already has, not
 * a second capability surface — so the realtime session gets the SAME exposure
 * split the text stack uses (`splitToolsForExposure`), and the SAME
 * tool_search / execute_tool scaffolding built by the SAME factories. Nothing
 * here curates a "voice subset": a curated list would be a second tool surface
 * that silently drifts from the text one every time a tool is added.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state. The
 * registry is a parameter, never a module-load import — building it has
 * env-dependent branches (the code-execution kill switch) that must stay the
 * caller's decision.
 */

import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import { splitToolsForExposure } from '../tools/tool-exposure';
import { createToolSearchTool } from '../tools/tool-search-tool';
import { createExecuteTool } from '../tools/execute-tool';
import type { RealtimeTool } from './session';

/**
 * Convert one tool's zod `inputSchema` to the plain JSON Schema the realtime
 * `parameters` field carries. Same call the text stack's tool_search uses
 * (`z.toJSONSchema`), so both surfaces describe a tool identically.
 *
 * Two things are load-bearing about zod v4's defaults here, both verified
 * against this registry:
 * - `reused: 'inline'` — schemas come back fully inlined, with no `$ref`/`$defs`.
 *   The realtime API takes `parameters` standalone, with nowhere to hang a
 *   definitions block, so a `$ref` would dangle.
 * - `unrepresentable: 'throw'` — a `z.date()`/`z.bigint()`/`z.map()` in a tool
 *   input throws rather than emitting a lie. That throw is deliberate and is
 *   asserted against the real registry in the tests: a silently mis-described
 *   parameter is worse than a loud failure at session build.
 *
 * The third default, `io: 'output'`, makes a field carrying a zod `.default()`
 * come back as `required` — `execute_tool.parameters` is the live example. Left
 * alone rather than switched to `io: 'input'`: the text stack renders the same
 * schema the same way, and the only cost is that the model always sends the
 * field explicitly instead of letting the default fill it in.
 *
 * `$schema` is dropped: it is a dialect annotation about the document, not part
 * of the parameter contract, and OpenAI's own function schemas never carry it
 * (strict schema validation rejects unsupported top-level keywords outright).
 */
function toRealtimeParameters(inputSchema: Tool['inputSchema']): Record<string, unknown> {
  const parameters = { ...(z.toJSONSchema(inputSchema as z.ZodType) as Record<string, unknown>) };
  delete parameters.$schema;
  return parameters;
}

/**
 * Realtime function tools are FLAT — `{ type, name, description, parameters }` —
 * not nested under a `function` key the way Chat Completions nests them.
 *
 * A missing description degrades to `''` rather than omitting the key: the
 * model loses the hint, but the definition stays structurally valid and the
 * tool stays callable. Dropping the whole tool would silently shrink voice's
 * capabilities relative to text.
 *
 * Exported for the registry-wide conversion guard: `buildRealtimeTools` only
 * converts the upfront half, so testing through it alone would never touch a
 * deferred tool's schema and an unrepresentable one could sit in the registry
 * unnoticed until a caller went looking for it.
 */
export function toRealtimeTool(name: string, tool: Tool): RealtimeTool {
  return {
    type: 'function',
    name,
    description: tool.description ?? '',
    parameters: toRealtimeParameters(tool.inputSchema),
  };
}

/**
 * Project a tool set onto the realtime tool definitions sent with the session.
 *
 * Emits the core tools with full schemas plus `tool_search` and `execute_tool`;
 * everything else is reachable through those two, exactly as in the Global
 * Assistant (`global-chat-turn.ts`). Front-loading every tool instead would
 * spend the session's context on schemas before the caller has said a word.
 *
 * `splitToolsForExposure` is called with NO always-upfront set. That set exists
 * to rescue composer-toggled tools (`web_search`, `generate_image`) from
 * execute_tool's allowlist re-check on the text routes — a voice call has no
 * composer toggles, so those tools defer like any other non-core tool and stay
 * reachable through execute_tool.
 *
 * The scaffolding is built by the real factories rather than hand-written
 * literals so the two tools cannot describe themselves differently to voice
 * than to text. Only their name/description/parameters are read here; wiring
 * their `execute` to the live call is the caller's job.
 *
 * `tool_search` receives the WHOLE set, not just the deferred half — core tools
 * are directly callable, so letting the model look one up is harmless, and it
 * matches the text stack's catalog.
 */
export function buildRealtimeTools(tools: ToolSet): readonly RealtimeTool[] {
  return Object.entries(buildRealtimeToolSet(tools)).map(([name, tool]) =>
    toRealtimeTool(name, tool),
  );
}

/**
 * The EXECUTABLE set behind those definitions — the same objects, before the
 * projection onto the wire shape.
 *
 * Split out from `buildRealtimeTools` so that what the session ADVERTISES and
 * what the dispatcher RUNS are one expression evaluated twice, not two lists
 * that agree today. They are built in different processes (definitions ride the
 * attach payload to `apps/realtime`; execution happens back here on the bridge),
 * which is exactly the arrangement where two hand-kept lists drift — the model
 * would call a name nothing answers, and the call would hang on a tool result
 * that never comes.
 *
 * It is also what makes `execute_tool` work over voice unchanged: the deferred
 * half is captured in the closure this returns, so a spoken request that
 * reaches a non-core tool goes through the SAME allowlist re-check and the SAME
 * `safeParse` the text stack uses.
 */
export function buildRealtimeToolSet(tools: ToolSet): ToolSet {
  const { coreTools, nonCoreTools } = splitToolsForExposure(tools);

  return {
    ...coreTools,
    tool_search: createToolSearchTool(tools),
    execute_tool: createExecuteTool(nonCoreTools),
  };
}
