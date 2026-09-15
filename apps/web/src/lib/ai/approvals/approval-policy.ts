/**
 * Tool-approval policy — the pure decision core for the human-in-the-loop gate.
 *
 * WHY THIS EXISTS. `ask_user` is a tool the MODEL may choose to call; nothing
 * deterministically stops a write. This module answers, per tool call, whether
 * the harness pauses for the user before executing it. The pause itself is the
 * AI SDK's native `needsApproval` (the step emits `tool-approval-request` and
 * the loop halts); execution of an approved call is PageSpace-owned and happens
 * at resume, on the ORIGINAL assistant message (see `core/approval-resume.ts`).
 *
 * Outcome is `allow | ask` — there is deliberately no `deny` outcome. A denial
 * only ever comes from the user's button; the policy never refuses on its own.
 *
 * Decisions (Jono, 2026-09-14):
 *  - Gated by default: every write (`WRITE_TOOLS`), every MCP tool, and every
 *    integration tool whose provider category is not `read`. Reads, `tool_search`,
 *    `finish`, `ask_user` never prompt.
 *  - Modes: `ask` (default, on by default) | `auto` (no prompts).
 *  - Non-interactive turns run as `auto`: worker dispatch (depth > 0), workflows,
 *    triggers, channel mentions. There is nobody to ask, and the interactive spawn
 *    or the automation setup was the consent.
 *  - Grants: "allow for this conversation" (conversationId set) and "always allow"
 *    (conversationId null), per user per tool.
 *
 * Pure: no IO, no clock, no module state — every input is a parameter so the
 * whole matrix is unit-testable.
 */

import type { ToolSet } from 'ai';
import { isWriteTool } from '../core/tool-filtering';
import { FINISH_TOOL_NAME } from '../tools/finish-tool';
import { ASK_USER_TOOL_NAME } from '../tools/ask-user-tools';

export const TOOL_APPROVAL_MODES = ['ask', 'auto'] as const;
export type ToolApprovalMode = (typeof TOOL_APPROVAL_MODES)[number];
export const DEFAULT_TOOL_APPROVAL_MODE: ToolApprovalMode = 'ask';

export const isToolApprovalMode = (value: unknown): value is ToolApprovalMode =>
  typeof value === 'string' && (TOOL_APPROVAL_MODES as readonly string[]).includes(value);

/** The search-mode dispatcher: its INPUT names the tool that actually runs. */
export const EXECUTE_TOOL_NAME = 'execute_tool';
const TOOL_SEARCH_TOOL_NAME = 'tool_search';

/**
 * Tools that never prompt whatever the mode: the loop's own scaffolding.
 * `ask_user` is execute-less (it IS a pause) and `finish` only ends the turn.
 */
export const NEVER_GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  FINISH_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  // Never gated BY ITS OWN NAME — the inner tool decides (resolveEffectiveToolName).
  EXECUTE_TOOL_NAME,
]);

/**
 * MCP tools arrive as `mcp:server:tool` and are renamed `mcp__server__tool` by
 * `sanitizeToolNamesForProvider` before the model sees them; the policy runs on
 * the sanitized set, so both spellings are recognised.
 */
export const isMcpToolName = (toolName: string): boolean =>
  toolName.startsWith('mcp__') || toolName.startsWith('mcp:');

export interface ToolApprovalGrant {
  toolName: string;
  /** `null` = "always allow" for this user; a conversation id = only that conversation. */
  conversationId: string | null;
}

export interface ApprovalPolicyContext {
  mode: ToolApprovalMode;
  /**
   * A human is present to answer: a browser session drove this turn and it is
   * not a dispatched worker turn (`X-Agent-Dispatch-Depth === 0`). Anything
   * else — workflow, trigger, channel mention, spawn_session/send_session
   * workers — is non-interactive and runs as `auto`.
   */
  interactive: boolean;
  conversationId: string | null;
  grants: readonly ToolApprovalGrant[];
  /**
   * Integration tool names whose provider category is not `read`
   * (`packages/lib/src/integrations/types.ts`). Supplied by the integration
   * resolver, which is the only place that knows the category; the policy does
   * not parse integration names itself.
   */
  gatedIntegrationToolNames?: ReadonlySet<string>;
}

export type ApprovalDecision = 'allow' | 'ask';

/**
 * The tool that will actually run. `execute_tool({tool_name, parameters})` is
 * the dispatcher for every deferred tool in search mode, so a decision (and the
 * card the user sees) must be about `tool_name`, never about `execute_tool`.
 * Unparseable input falls back to the outer name — which is never gated, so a
 * half-streamed dispatcher call cannot pause the turn.
 */
export function resolveEffectiveToolName(toolName: string, input: unknown): string {
  if (toolName !== EXECUTE_TOOL_NAME) return toolName;
  if (typeof input !== 'object' || input === null) return toolName;
  const inner = (input as { tool_name?: unknown }).tool_name;
  return typeof inner === 'string' && inner.length > 0 ? inner : toolName;
}

/** Whether a (resolved) tool name is in the gated set, independent of mode/grants. */
export function isApprovalGatedTool(
  toolName: string,
  gatedIntegrationToolNames?: ReadonlySet<string>,
): boolean {
  if (NEVER_GATED_TOOL_NAMES.has(toolName)) return false;
  if (isWriteTool(toolName)) return true;
  if (isMcpToolName(toolName)) return true;
  return gatedIntegrationToolNames?.has(toolName) ?? false;
}

const hasGrant = (ctx: ApprovalPolicyContext, toolName: string): boolean =>
  ctx.grants.some(
    (grant) =>
      grant.toolName === toolName &&
      (grant.conversationId === null ||
        (ctx.conversationId !== null && grant.conversationId === ctx.conversationId)),
  );

/**
 * Should THIS call pause for the user? Order is behaviour: a non-interactive
 * turn or `auto` mode short-circuits before any classification, so those paths
 * cost nothing and can never pause; grants are consulted only for gated tools.
 */
export function decideApproval(
  call: { toolName: string; input: unknown },
  ctx: ApprovalPolicyContext,
): ApprovalDecision {
  if (!ctx.interactive || ctx.mode === 'auto') return 'allow';
  const effective = resolveEffectiveToolName(call.toolName, call.input);
  if (!isApprovalGatedTool(effective, ctx.gatedIntegrationToolNames)) return 'allow';
  return hasGrant(ctx, effective) ? 'allow' : 'ask';
}

// ─── Tool-set wrapper ──────────────────────────────────────────────────────────

/**
 * Hand the SDK the decision: every gated tool with an `execute` gets a
 * `needsApproval` that asks {@link decideApproval} per call. Everything else is
 * returned AS THE SAME OBJECT — execute-less tools (`ask_user` is itself a
 * pause), provider-executed tools (the provider runs them; there is no seam), and
 * ungated reads — so the exposure split, `execute_tool`'s dispatch map, and every
 * identity-based test keep seeing the tools they were built from.
 *
 * In `auto` mode or a non-interactive turn the input set is returned untouched
 * (same reference): zero overhead, and provably nothing can pause.
 *
 * MUST run after the LAST tool merge (after `finishTool`/`askUserTools`), on the
 * sanitized set: `sanitizeToolNamesForProvider` renames MCP tools to `mcp__…`
 * but keeps the tool object, so a `needsApproval` set here survives — and one
 * set before the merge would be missing from whatever the merge added.
 */
export function applyApprovalPolicy<TOOLS extends ToolSet>(
  tools: TOOLS,
  ctx: ApprovalPolicyContext,
): TOOLS {
  if (!ctx.interactive || ctx.mode === 'auto') return tools;

  const out: ToolSet = {};
  let changed = false;
  for (const [name, tool] of Object.entries(tools)) {
    const wrappable =
      typeof tool.execute === 'function' &&
      tool.type !== 'provider' &&
      (name === EXECUTE_TOOL_NAME || isApprovalGatedTool(name, ctx.gatedIntegrationToolNames));
    if (!wrappable) {
      out[name] = tool;
      continue;
    }
    out[name] = {
      ...tool,
      needsApproval: async (input: unknown) => decideApproval({ toolName: name, input }, ctx) === 'ask',
    } as ToolSet[string];
    changed = true;
  }
  return changed ? (out as TOOLS) : tools;
}
