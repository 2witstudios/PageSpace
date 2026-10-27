/**
 * PageSpace's AI SDK tool registry, projected onto the realtime wire shape.
 *
 * Voice is a second transport onto the conversations PageSpace already has, not
 * a second capability surface — so the realtime session gets its exposure from
 * the SAME function the text routes use (`applyToolExposureMode`), which yields
 * the tool set and the discovery prompt describing it as one result. Nothing
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
import { applyToolExposureMode } from '../tools/tool-exposure';
import { filterToolsForAgentAllowlist } from '../core/tool-filtering';
import { listEligibleSkills } from '../core/skill-catalog';
import type { RealtimeTool } from './session';

/**
 * A bound page agent's saved tool allowlist (`pages.enabledTools`), or null for
 * an unconfigured agent and for the Global Assistant.
 *
 * `null` and `[]` are NOT the same value and the difference is the whole point:
 * null is "its owner never restricted it", `[]` is "its owner switched every
 * PageSpace tool off". Collapsing them — which is what passing `undefined`
 * around does — turns the second into the first.
 */
export type ToolAllowlist = readonly string[] | null;

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
 * Exported for the registry-wide conversion guard: an exposure only ever
 * converts the upfront half, so testing through that alone would never touch a
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
 * A voice call has no composer toggles, so nothing is rescued from deferral.
 *
 * The always-upfront set exists to keep `web_search` / `generate_image` directly
 * callable on the text routes, where they are added independently of an agent's
 * saved allowlist and would then fail execute_tool's re-check. Nothing adds
 * them to a call, so they defer like any other non-core tool.
 */
const NO_COMPOSER_OVERRIDES: ReadonlySet<string> = new Set();

/**
 * How a call's tools are exposed to the model: the set it may call, and the
 * prompt text that tells it how to reach everything else.
 *
 * THE TWO TRAVEL TOGETHER BECAUSE THEY ARE ONE DECISION. Voice used to build
 * the tool half by hand and simply never build the prompt half — so `tool_search`
 * and `execute_tool` rode every session while nothing in the instructions ever
 * named them, and every non-core tool (the calendar family, spawn_session,
 * create_task, the workflow tools) was loaded and undiscoverable. The model
 * answered "I can't do that" about tools it was holding.
 */
export type RealtimeToolExposure = {
  readonly tools: ToolSet;
  /** Both halves as one block: how to reach deferred tools, then their names. */
  readonly toolDiscoveryPrompt: string;
  /** The catalog alone, for the surface that states the "how" earlier. */
  readonly nonCoreToolNames: string;
  /**
   * Every tool the agent may reach, named BEFORE the split moved most of them
   * behind `execute_tool` — which is what the prompt's capability sections have
   * to be gated on.
   *
   * Returned rather than left for the caller to derive because deriving it from
   * `tools` is wrong in a way nothing catches: after the split that object holds
   * the core tools and the two scaffolding tools and nothing else, so gating on
   * its keys silently drops the task-management, delegation and automation
   * guidance for every capability the split deferred — the exact capabilities
   * the discovery catalog then advertises as callable. `page-chat-turn.ts:1306`
   * captures the same list at the same point, for the same reason.
   */
  readonly allowedToolNames: string[];
};

/**
 * Decide the exposure for a call: allowlist first, then the SAME search-mode
 * split the text routes use.
 *
 * `applyToolExposureMode(_, 'search')` is called rather than reproduced. It
 * already emits the core tools with full schemas, defers the rest behind
 * `tool_search` / `execute_tool` built by the real factories, and returns the
 * discovery prompt naming what was deferred — one expression, so the advertised
 * tools and the text describing them cannot disagree. Reproducing its body here
 * is what dropped the prompt in the first place.
 *
 * THE AGENT'S ALLOWLIST IS APPLIED FIRST, before the split and before
 * `tool_search` is handed its catalog — the same order `page-chat-turn.ts` uses,
 * and for the same reason: filtering afterwards would leave blocked tools
 * discoverable through `tool_search` and callable through `execute_tool`, which
 * is every tool the agent's owner switched off.
 *
 * WITH NOTHING TO DEFER THERE IS NO SCAFFOLDING. An agent allowed only core
 * tools (or none at all) gets its tools and an empty discovery prompt, rather
 * than a `tool_search` over an empty catalog and an `execute_tool` that can only
 * refuse. That is `applyToolExposureMode`'s own rule and it is the honest one:
 * two tools whose every call fails are worse than two tools absent.
 *
 * The skill catalog handed to `tool_search` is the BUILT-IN one only. The text
 * routes also merge in per-viewer user/drive commands, which are volatile by
 * nature — they change whenever anyone edits a command — and a call's
 * instructions are sent once at socket open, so a snapshot of them would go
 * stale mid-call with no way to correct it.
 */
export function buildRealtimeToolExposure(
  tools: ToolSet,
  allowlist: ToolAllowlist = null,
): RealtimeToolExposure {
  const allowed = filterToolsForAgentAllowlist(
    tools,
    allowlist === null ? null : [...allowlist],
  ) as ToolSet;

  const allowedToolNames = Object.keys(allowed);

  // The searchable skills are derived from the same pre-split names and handed
  // straight to the exposure. Computed here rather than accepted as a parameter:
  // it is a pure function of those names, and a parameter no caller passed is
  // exactly how `tool_search` ended up with a tools-only corpus while the prompt
  // advertised a skill catalog.
  return {
    ...applyToolExposureMode(
      allowed,
      'search',
      NO_COMPOSER_OVERRIDES,
      listEligibleSkills(allowedToolNames),
    ),
    allowedToolNames,
  };
}

/**
 * Project an exposure's tool set onto the definitions sent with the session.
 *
 * Takes the ALREADY-EXPOSED set rather than a registry and an allowlist,
 * because its one caller has the exposure in hand and the prompt describing
 * those same tools comes out of it: re-deriving the exposure here would put the
 * advertised list and the text describing it back on separate computations.
 *
 * Only each tool's name/description/parameters are read; wiring their `execute`
 * to the live call is the caller's job.
 */
export function toRealtimeTools(tools: ToolSet): readonly RealtimeTool[] {
  return Object.entries(tools).map(([name, tool]) => toRealtimeTool(name, tool));
}

/**
 * The EXECUTABLE set behind those definitions — the same objects, before the
 * projection onto the wire shape.
 *
 * Split out from the exposure's own projection so that what the session
 * ADVERTISES and what the dispatcher RUNS are one expression evaluated twice,
 * not two lists that agree today. They are built in different processes (definitions ride the
 * attach payload to `apps/realtime`; execution happens back here on the bridge),
 * which is exactly the arrangement where two hand-kept lists drift — the model
 * would call a name nothing answers, and the call would hang on a tool result
 * that never comes.
 *
 * It is also what makes `execute_tool` work over voice unchanged: the deferred
 * half is captured in the closure this returns, so a spoken request that
 * reaches a non-core tool goes through the SAME allowlist re-check and the SAME
 * `safeParse` the text stack uses.
 *
 * The discovery prompt half of the exposure is dropped here on purpose — the
 * dispatcher runs tools, it does not prompt. `binding-loader.ts` takes the
 * exposure whole.
 */
export function buildRealtimeToolSet(tools: ToolSet, allowlist: ToolAllowlist = null): ToolSet {
  return buildRealtimeToolExposure(tools, allowlist).tools;
}
