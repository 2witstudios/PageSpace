/**
 * Spawn / kill / labeling planning for BOTH agent-session registries (pure).
 *
 * The two registries are deliberately asymmetric, and this module is where that
 * asymmetry is written down:
 *
 *  - **Worker sessions** (`spawn_session`): the name is a FREE label. No
 *    uniqueness, no charset rules, no addressing role — two workers may share a
 *    name and nothing is ambiguous, because the spawn returns a `sessionId` and
 *    every verb afterwards (`send_session`, `read_session`, `kill_session`) takes
 *    that id. What IS validated is the work: a spawn with no prompt is
 *    meaningless (spawning a worker means giving it work), and the depth and
 *    concurrency caps are enforced as pure data.
 *  - **Shells** (`spawn_shell`): the name is still a label, but it is unique per
 *    session so tabs are unambiguous — so an auto-label must not collide, and a
 *    requested duplicate is rejected rather than silently renamed.
 *
 * Nothing here guarantees anything about ADDRESSING — ids do that. This module
 * only decides what a thing is called and whether the spawn is allowed at all.
 */

/** Ported from `agent-communication-tools.ts` — the cap that stops agents recursing into each other forever. */
export const MAX_AGENT_DEPTH = 2;

/**
 * The most ACTIVE conversations one session may hold — what a worker spawn (or
 * an HTTP conversation-create) actually mints, and therefore the quantity its
 * cap must count (the sandbox-concurrency inputs count VMs, which a spawn
 * never creates — issue #2262 finding 2). 100 deliberately equals
 * `listSessionConversationsBulk`'s per-session listing cap: a session can
 * never hold more conversations than its sidebar listing can show.
 */
export const MAX_SESSION_CONVERSATIONS = 100;

export const SHELL_LABEL_PREFIX = 'shell-';

const MAX_SHELL_NAME_LENGTH = 100;
const SHELL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * A shell's tab label. Same rule as the predecessor's session names
 * (`isValidAgentTerminalName`): starts alphanumeric, then alphanumerics, dashes
 * and underscores. Not a git ref, not a path — just something safe to render in
 * a tab and put in a unique index.
 */
export function isValidShellName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_SHELL_NAME_LENGTH) return false;
  return SHELL_NAME_RE.test(name);
}

/**
 * The auto-label for a new shell: `shell-(n+1)` for n existing shells, advanced
 * past anything already taken.
 *
 * Counting FIRST (rather than filling the lowest free index) keeps the label
 * meaningful as an ordinal — the third shell you open reads as `shell-3` even if
 * `shell-2` was closed — and the collision scan is what makes it safe against the
 * `(sessionId, name)` unique index, including when a user has renamed shells into
 * the pattern.
 */
export function nextShellLabel(existingNames: readonly string[]): string {
  const taken = new Set(existingNames);
  // Terminates by construction: `taken` is finite, so the scan runs out of
  // collisions after at most `taken.size` steps.
  let index = existingNames.length + 1;
  while (taken.has(`${SHELL_LABEL_PREFIX}${index}`)) index += 1;
  return `${SHELL_LABEL_PREFIX}${index}`;
}

export type PlanSpawnShellResult =
  | { ok: true; name: string; autoLabeled: boolean }
  | { ok: false; reason: 'invalid_name' | 'name_taken' };

export interface PlanSpawnShellInput {
  /** Every shell name already live in THIS session — the scope of the uniqueness rule. */
  existingNames: readonly string[];
  /** Absent or blank asks for an auto-label; opening a shell is one act, never a naming step. */
  requestedName?: string;
}

export function planSpawnShell({ existingNames, requestedName }: PlanSpawnShellInput): PlanSpawnShellResult {
  const requested = requestedName?.trim() ?? '';
  if (requested.length === 0) {
    return { ok: true, name: nextShellLabel(existingNames), autoLabeled: true };
  }
  if (!isValidShellName(requested)) return { ok: false, reason: 'invalid_name' };
  // Rejected rather than auto-renamed: the caller asked for a specific tab label,
  // and silently handing back a different one is worse than saying no.
  if (existingNames.includes(requested)) return { ok: false, reason: 'name_taken' };
  return { ok: true, name: requested, autoLabeled: false };
}

export type PlanKillTargetResult =
  | { ok: true; action: 'kill'; targetId: string }
  | { ok: true; action: 'noop'; targetId: string; reason: 'already_gone' }
  | { ok: false; reason: 'invalid_target' };

export interface PlanKillTargetInput {
  /** The ids currently in the registry — shell ids or session ids; this only ever compares ids. */
  knownIds: readonly string[];
  targetId: string;
}

/**
 * Killing something already gone is SUCCESS, not a 404.
 *
 * Teardown is idempotent by nature and its callers are usually cleanup paths
 * (closing a tab, ending a session, unwinding a failed spawn) that retry. Making
 * "already gone" an error forces every caller to special-case it — which is what
 * the predecessor's in-flight-kill bookkeeping existed to paper over.
 */
export function planKillTarget({ knownIds, targetId }: PlanKillTargetInput): PlanKillTargetResult {
  if (targetId.length === 0) return { ok: false, reason: 'invalid_target' };
  if (!knownIds.includes(targetId)) {
    return { ok: true, action: 'noop', targetId, reason: 'already_gone' };
  }
  return { ok: true, action: 'kill', targetId };
}

const MAX_SESSION_NAME_LENGTH = 200;

export type PlanSpawnWorkerSessionResult =
  | { ok: true; name: string; prompt: string; agentId: string | null; childDepth: number }
  | {
      ok: false;
      reason: 'invalid_name' | 'missing_prompt' | 'depth_exceeded' | 'concurrency_exceeded' | 'session_full';
    };

export interface PlanSpawnWorkerSessionInput {
  /** A free display label. Any characters; only blank or absurdly long is refused. */
  name: string;
  /** REQUIRED: spawning a worker means giving it work. */
  prompt: string;
  /** The agent page to spawn the worker under — an agentId, never called a "page" in the schema. */
  agentId?: string | null;
  /** How deep the CALLER already is. A caller at the cap may not spawn. */
  callerDepth: number;
  /** Live sessions already counted against the owner's quota. */
  activeSessionCount: number;
  /** The owner's tier concurrency ceiling. */
  concurrencyLimit: number;
  /**
   * ACTIVE conversations already living in the caller's session — the quantity
   * a spawn actually mints, compared against `MAX_SESSION_CONVERSATIONS`.
   * Required: without it the only spawn cap counts sandboxes, which a worker
   * spawn never creates, and worker minting is unbounded.
   */
  sessionConversationCount: number;
  /** Accepted and ignored for uniqueness — worker names are free labels. Present so callers need no special case. */
  existingNames?: readonly string[];
}

export function planSpawnWorkerSession({
  name,
  prompt,
  agentId = null,
  callerDepth,
  activeSessionCount,
  concurrencyLimit,
  sessionConversationCount,
}: PlanSpawnWorkerSessionInput): PlanSpawnWorkerSessionResult {
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length === 0) return { ok: false, reason: 'missing_prompt' };

  const trimmedName = name.trim();
  if (trimmedName.length === 0 || trimmedName.length > MAX_SESSION_NAME_LENGTH) {
    return { ok: false, reason: 'invalid_name' };
  }

  // Input problems are reported before quota problems: a malformed spawn is the
  // caller's bug and stays a bug at any quota, whereas a quota denial is a
  // transient condition the caller can retry.
  if (callerDepth >= MAX_AGENT_DEPTH) return { ok: false, reason: 'depth_exceeded' };
  // Account-level ceiling before the session-level one: the account problem is
  // the broader condition, and its remedy (a whole session ending) is different
  // from the session-full remedy (reuse an existing worker).
  if (activeSessionCount >= concurrencyLimit) return { ok: false, reason: 'concurrency_exceeded' };
  if (sessionConversationCount >= MAX_SESSION_CONVERSATIONS) return { ok: false, reason: 'session_full' };

  return { ok: true, name: trimmedName, prompt: trimmedPrompt, agentId, childDepth: callerDepth + 1 };
}
