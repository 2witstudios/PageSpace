/**
 * What an agent's STORED tool config will actually become at runtime.
 *
 * `pages.enabledTools` is an allowlist, not a grant. Between it and the model's
 * real tool surface sit gates the allowlist cannot re-open — chiefly the
 * per-agent sandbox switch (`pages.sandboxEnabled`, see
 * `filterToolsForSandboxEnablement`), which strips the WHOLE sandbox family
 * whatever the allowlist says. An agent configured entirely through
 * `update_agent_config` could therefore store twenty-four tool names, have them
 * echoed back intact on every write, and run with a page-only surface forever,
 * with nothing anywhere saying so (issue #2460).
 *
 * This module is the one place that answers "what of this config survives?",
 * so the config tool's echo, the spawn refusal, and any future surface can
 * describe the same divergence in the same words. It is PURE — the registered
 * tool names are passed in, never imported — so it can be reasoned about and
 * unit-tested without the tool registry or the database.
 *
 * It deliberately does NOT model the two gates that are not knowable from
 * stored config:
 *
 *  - the PAYER-tier gate (`filterToolsForSandboxTier`) and the bound-session
 *    requirement behind it, which depend on the session a conversation lands in
 *    (`resolveSandboxToolEligibilityForConversation`) — the same agent
 *    legitimately resolves differently in two workspaces;
 *  - `filterToolsForReadOnly` / `filterToolsForMcpScope`, which are properties
 *    of the REQUEST, not the agent.
 *
 * Callers that want to mention those say so as a caveat (see
 * {@link formatAgentToolSurfaceNotes}); claiming to have checked them here
 * would be the same silent-divergence bug one level up.
 */

import { SANDBOX_TOOL_NAMES, SANDBOX_COMPUTE_TOOL_NAMES } from './tool-filtering';
import { CORE_TOOL_NAMES } from './stub-tools';
import { ALWAYS_UPFRONT_TOOLS } from '../tools/tool-exposure';

/** Why a configured tool never reaches the model. */
export type BlockedToolGate =
  /** The agent's `sandboxEnabled` switch is off — the sandbox family is stripped wholesale. */
  | 'sandbox_disabled'
  /** No tool by that name is registered for this caller (renamed, removed, or kill-switched). */
  | 'not_registered';

export interface BlockedTool {
  tool: string;
  gate: BlockedToolGate;
}

export interface AgentToolSurface {
  /** The stored allowlist. `null` = unconfigured, i.e. every registered tool. */
  configured: string[] | null;
  /** Configured (or, unconfigured, registered) tools the model can actually call. */
  granted: string[];
  /** Configured tools no gate will grant, each with the gate that dropped it. */
  blocked: BlockedTool[];
  /**
   * Granted, but not sent upfront: in `'search'` exposure mode the model sees
   * only the core tools plus `tool_search`/`execute_tool` and must discover
   * these. NOT a loss of capability — and precisely why a search-mode agent
   * "looks like" it has page tools only, which is how this issue was first
   * misread.
   */
  deferred: string[];
}

export function describeAgentToolSurface(input: {
  enabledTools: string[] | null;
  sandboxEnabled: boolean;
  toolExposureMode: 'upfront' | 'search';
  /** Tool names registered for this caller — `Object.keys` of the resolved registry. */
  registeredToolNames: readonly string[];
}): AgentToolSurface {
  const { enabledTools, sandboxEnabled, toolExposureMode, registeredToolNames } = input;
  const registered = new Set(registeredToolNames);

  const blocked: BlockedTool[] = [];
  let granted: string[];

  if (enabledTools === null) {
    // Unconfigured: nothing was ASKED for, so nothing can be denied — the
    // sandbox switch narrows the surface here without contradicting anything.
    granted = registeredToolNames.filter((name) => sandboxEnabled || !SANDBOX_TOOL_NAMES.has(name));
  } else {
    granted = [];
    for (const name of enabledTools) {
      // Registration is checked FIRST: when a name is not registered at all,
      // flipping `sandboxEnabled` would not bring it back, so naming the
      // sandbox switch there would send the reader after the wrong fix.
      if (!registered.has(name)) {
        blocked.push({ tool: name, gate: 'not_registered' });
        continue;
      }
      if (!sandboxEnabled && SANDBOX_TOOL_NAMES.has(name)) {
        blocked.push({ tool: name, gate: 'sandbox_disabled' });
        continue;
      }
      granted.push(name);
    }
  }

  const deferred =
    toolExposureMode === 'search'
      ? granted.filter((name) => !CORE_TOOL_NAMES.has(name) && !ALWAYS_UPFRONT_TOOLS.has(name))
      : [];

  return { configured: enabledTools, granted, blocked, deferred };
}

/** The tools this surface blocks for one specific gate, in config order. */
export function blockedByGate(surface: AgentToolSurface, gate: BlockedToolGate): string[] {
  return surface.blocked.filter((entry) => entry.gate === gate).map((entry) => entry.tool);
}

/**
 * Human sentences for everything that will NOT behave the way the stored config
 * reads. Empty when the config is honoured verbatim — so a caller can treat a
 * non-empty result as "say this out loud" without deciding anything itself.
 */
export function formatAgentToolSurfaceNotes(surface: AgentToolSurface): string[] {
  const notes: string[] = [];

  const sandboxBlocked = blockedByGate(surface, 'sandbox_disabled');
  if (sandboxBlocked.length > 0) {
    notes.push(
      `These configured tools are NOT granted because this agent's sandboxEnabled switch is off: ${sandboxBlocked.join(', ')}. ` +
        'Call update_agent_config with sandboxEnabled: true to grant them, or remove them from enabledTools.'
    );
  }

  const unregistered = blockedByGate(surface, 'not_registered');
  if (unregistered.length > 0) {
    notes.push(
      `These configured tools are NOT granted because no tool by that name is available here: ${unregistered.join(', ')}. ` +
        'They may have been renamed, or the deployment does not offer them.'
    );
  }

  if (surface.deferred.length > 0) {
    notes.push(
      `In "search" exposure mode these granted tools are not sent upfront — the model reaches them through tool_search/execute_tool: ${surface.deferred.join(', ')}.`
    );
  }

  // Only the COMPUTE subset is tier-gated — the chat-side session family is
  // free on every plan (`filterToolsForSandboxTier`), so naming it here would
  // invent a caveat that does not exist.
  if (surface.granted.some((name) => SANDBOX_COMPUTE_TOOL_NAMES.has(name))) {
    notes.push(
      'Sandbox compute tools (bash/files, git+gh, shells) additionally require an eligible payer tier and a session to run in; that is resolved per conversation, not from this config.'
    );
  }

  return notes;
}
