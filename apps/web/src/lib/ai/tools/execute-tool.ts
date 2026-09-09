import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import type { ToolExecutionContext } from '../core/types';
import { formatInvalidParametersError, formatUnknownToolError } from './tool-error-schema';

/**
 * Exported because the admin prompt viewer renders "the complete AI request
 * payload exactly as it would be sent to the LLM" and had a hand-typed copy of
 * this sentence in two places. They drifted the moment this one changed, so an
 * admin inspecting the context window saw an instruction the model is no longer
 * given — the exact opposite of what that screen is for.
 */
export const EXECUTE_TOOL_DESCRIPTION =
  'Execute any PageSpace tool by name. Use tool_search to discover what exists, and to check a schema when a filter or limit has to be right — unrecognised optional keys are dropped, not rejected. A call rejected for bad parameters comes back with the schema, so that mistake needs no lookup.';

/**
 * What the model is told when `tool_name` never arrived (#2461).
 *
 * The AI SDK coerces a tool call that carried NO argument tokens into an empty
 * object before validating it (`parseToolCall` → `doParseToolCall`:
 * `toolCall.input.trim() === '' ? safeValidateTypes({ value: {}, schema })`), so
 * a response cut off the instant after the tool-use block opened arrives here
 * indistinguishable from a genuinely malformed envelope. Zod's stock wording for
 * that — "expected string, received undefined" — reads as "you forgot a field",
 * which is a lie about what happened and, worse, is not actionable: an agent
 * that believes it sent `tool_name` has nothing to change, so it re-sends the
 * identical call. #2461 is exactly that loop, ~10 identical failures deep.
 *
 * Naming truncation turns the wedge into a recoverable error, because the
 * recovery (send a smaller payload) is one the model can actually perform.
 *
 * But this callback fires on the FIELD, and a field-level zod issue carries only
 * the value at its own path — `undefined` either way. So `{}` (nothing arrived)
 * and `{"parameters": {...}}` (arguments arrived, the name did not) are
 * indistinguishable here, and asserting the first would send a model that merely
 * omitted a key off shrinking a payload that was never the problem. The wording
 * therefore claims only what is true in both cases — the name did not arrive —
 * and offers each cause its own recovery, letting the model pick the one that
 * matches what it actually sent.
 */
export const MISSING_TOOL_NAME_ERROR =
  'execute_tool requires tool_name, and this call did not carry one. ' +
  'If you did set it, the response was cut off before the arguments finished — an oversized ' +
  'parameters payload is the usual reason, and retrying unchanged would fail the same way, so ' +
  're-send with fewer items per call. If you left it out, re-send the same call with tool_name set.';

export function createExecuteTool(allowedTools: ToolSet): Tool {
  return {
    description: EXECUTE_TOOL_DESCRIPTION,
    inputSchema: z.object({
      // The custom message is the whole point — see MISSING_TOOL_NAME_ERROR. It
      // reaches the model because the SDK embeds zod's rendered issues in the
      // tool-error result it feeds back into the loop. Custom messages are not
      // part of the JSON Schema handed to the provider, so the tool contract the
      // model is offered is byte-for-byte unchanged.
      tool_name: z.string({
        error: (issue) =>
          issue.input === undefined
            ? MISSING_TOOL_NAME_ERROR
            : `tool_name must be a string (received ${typeof issue.input}).`,
      }),
      parameters: z.record(z.string(), z.unknown()).default({}),
    }),
    execute: async (
      { tool_name, parameters }: { tool_name: string; parameters: Record<string, unknown> },
      options: unknown
    ) => {
      const enabledTools = (options as { experimental_context?: ToolExecutionContext })
        ?.experimental_context?.enabledTools;

      // `Object.hasOwn`, not a truthiness check on the lookup: the registry is
      // a plain object, so `allowedTools['constructor']` (or 'toString', or
      // '__proto__') resolves up the prototype chain and comes back TRUTHY.
      // Nothing could run — `execute` is undefined on all of them — but the
      // model was told "has no execute implementation" for a name that simply
      // is not a tool, instead of being handed the near-miss suggestion this
      // branch exists to give.
      const t = Object.hasOwn(allowedTools, tool_name) ? allowedTools[tool_name] : undefined;
      if (!t) {
        // A name that is in no registry at all is a MISTAKE, not a permission
        // outcome, and answering it with "not permitted" (as this did while the
        // allowlist check ran first) sent an agent looking for a setting to
        // change instead of a typo to fix. The allowlist still gates below;
        // nothing reaches `execute` without passing it.
        //
        // Suggestions come from what THIS caller may actually run, not from the
        // whole registry — naming a tool the agent's owner switched off would
        // trade an unknown-tool error for a not-permitted one.
        const reachable = Object.keys(allowedTools).filter(
          (name) => enabledTools == null || enabledTools.includes(name)
        );
        return { error: formatUnknownToolError(tool_name, reachable) };
      }
      if (enabledTools != null && !enabledTools.includes(tool_name)) {
        return { error: `Tool "${tool_name}" is not permitted for this agent.` };
      }
      if (!t.execute) {
        return { error: `Tool "${tool_name}" has no execute implementation.` };
      }
      const realSchema = t.inputSchema as z.ZodType;
      const parsed = realSchema.safeParse(parameters);
      if (!parsed.success) {
        // The schema goes in the error rather than a pointer to `tool_search`:
        // it is right here, and the pointer cost a round trip on every
        // first-use parameter mistake. See `tool-error-schema.ts`.
        return { error: formatInvalidParametersError(tool_name, realSchema, parsed.error.message) };
      }
      return (t.execute as (args: unknown, opts: unknown) => unknown)(parsed.data, options);
    },
  };
}
