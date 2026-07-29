/**
 * Sandbox status: one derivation, one vocabulary.
 *
 * Everything that mentions a conversation's sandbox — the session header's
 * chip, the sidebar row, and any tool renderer that reports on it — reads
 * through here, so a session can never look "running" in one place and "none"
 * in another.
 *
 * The words matter as much as the branch. `agent_sessions` is the backend's
 * name for the row and "session" is the tool/AI word for it, but a user never
 * sees that word: they see an Agent, its conversations, and — when one has
 * acquired compute — a sandbox. This module holds the only user-facing copy
 * about that thing, which is what makes the rule checkable instead of merely
 * agreed.
 */

import {
  SANDBOX_STATUSES,
  type AgentSessionDTO,
  type SandboxStatus,
} from '@pagespace/lib/agent-sessions/contract';

const KNOWN_STATUSES: ReadonlySet<string> = new Set<string>(SANDBOX_STATUSES);

/**
 * The status to render for a conversation, given whatever the session endpoint
 * returned for it.
 *
 * `undefined`/`null` — the hook is still loading, the row doesn't exist, or the
 * GET 404'd — is `'none'`, NOT an error. Most conversations never acquire a
 * sandbox at all; "no row" is this surface's resting state, and treating it as a
 * failure would paint an error on nearly every conversation in the tree.
 *
 * A status outside the contract's four (a newer server, a hand-rolled fixture)
 * also degrades to `'none'`: this build cannot render a state it doesn't know,
 * and "no sandbox" is the reading that offers to start one rather than claiming
 * one is already live.
 */
export function deriveSandboxStatus(session: AgentSessionDTO | null | undefined): SandboxStatus {
  if (!session) return 'none';
  // An explicitly-ended session reads as ended even if `sandboxStatus` hasn't
  // caught up — the row survives teardown for re-provisioning, so the stamp is
  // the more recent fact about it.
  if (session.endedAt) return 'ended';
  if (!KNOWN_STATUSES.has(session.sandboxStatus)) return 'none';
  return session.sandboxStatus;
}

export interface SandboxStatusCopy {
  /** Chip text. Short enough to sit in a header beside a title. */
  label: string;
  /** One sentence of "what this means", for a tooltip or a row's second line. */
  description: string;
}

/**
 * The four states in the user's words. Note what is NOT here: a "hibernating"
 * state. Idle sandboxes hibernate and wake on demand, which the contract
 * deliberately folds into `'running'` — surfacing it would ask the user to care
 * about something they cannot act on.
 */
export const SANDBOX_STATUS_COPY: Readonly<Record<SandboxStatus, SandboxStatusCopy>> = {
  none: {
    label: 'No sandbox',
    description: 'This conversation has no sandbox yet. One starts the first time the agent needs to run something.',
  },
  starting: {
    label: 'Starting',
    description: 'The sandbox is starting up.',
  },
  running: {
    label: 'Ready',
    description: 'The sandbox is ready. Chat and shells here share it.',
  },
  ended: {
    label: 'Stopped',
    description: 'The sandbox was stopped. A new one starts on the next command.',
  },
};

export function describeSandboxStatus(status: SandboxStatus): SandboxStatusCopy {
  return SANDBOX_STATUS_COPY[status];
}

/**
 * Whether there is a sandbox to open something in right now. `'starting'` is
 * deliberately false — the distinction a caller gating an Add-shell affordance
 * needs is "can I use it this instant", and a sandbox mid-provision cannot host
 * a PTY yet.
 */
export function isSandboxLive(status: SandboxStatus): boolean {
  return status === 'running';
}
