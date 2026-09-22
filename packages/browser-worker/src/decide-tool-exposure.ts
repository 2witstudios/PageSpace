/**
 * Which browser tools does this agent get? — pure.
 *
 * Every hard gate must be open, or the answer is none: a configured substrate
 * (and control key), the platform code-execution kill switch, the agent's own
 * sandbox switch, and a payer tier that may run machines — a browser session
 * is a billable machine exactly like a sandbox (S3 R14). Then the agent's
 * allowlist narrows the set, and a read-only agent keeps only the tools that
 * observe (read, screenshot): navigating, clicking, typing and opening tabs
 * can all submit something to the web.
 *
 * The registry asks it with every gate (through the request-time filters for
 * the per-agent switch, tier and read-only). The tool's execute path asks it
 * again for the agent's allowlist only — the kill switch, tier and quota are
 * re-checked there by the sandbox call-time gate instead.
 */
import { BROWSER_MUTATING_TOOL_NAMES, BROWSER_TOOL_NAMES, type BrowserToolName } from './browser-tool-name.js';

export type DecideToolExposureOptions = {
  /** A substrate and the control signing key are configured on this server. */
  readonly substrateConfigured: boolean;
  /** The platform-wide code-execution kill switch. */
  readonly codeExecutionEnabled: boolean;
  readonly agent: {
    readonly sandboxEnabled: boolean;
    /** The agent's tool allowlist; `null` means no allowlist. */
    readonly enabledTools: readonly string[] | null;
    readonly readOnly: boolean;
  };
  /** Whether the paying principal's tier may run machines. */
  readonly tierEligible: boolean;
};

export const decideToolExposure = ({ substrateConfigured, codeExecutionEnabled, agent, tierEligible }: DecideToolExposureOptions): readonly BrowserToolName[] => {
  if (!substrateConfigured || !codeExecutionEnabled || !agent.sandboxEnabled || !tierEligible) return [];
  return BROWSER_TOOL_NAMES.filter(
    (name) => (agent.enabledTools === null || agent.enabledTools.includes(name)) && !(agent.readOnly && BROWSER_MUTATING_TOOL_NAMES.includes(name)),
  );
};
