/**
 * Agent Terminals: spawn / resolve (attach) / kill / list named, pluggable-
 * agent-typed PTY sessions at one of the three universal Terminal scopes
 * (tasks/terminal.md), mirroring PurePoint's `AgentLocation::Root` /
 * `AgentLocation::Worktree` (`crates/pu-core/src/types/manifest.rs`):
 * `machine` (the owning Machine's OWN persistent Sprite, cwd = its home dir),
 * `project` (the SAME Machine Sprite, cwd = a cloned project's checkout), or
 * `branch` (the branch-terminal's OWN isolated Sprite, `machine_branches`).
 *
 * `spawnAgentTerminal` and `listAgentTerminals` are addressed by scope
 * (`machineId` + optional `projectName`/`branchName` — neither → machine,
 * `projectName` only → project, both → branch), since creating or enumerating
 * within a scope requires knowing which one. `resolveAgentTerminal` and
 * `killAgentTerminal` (by-name equivalents, kept for today's only wired
 * consumer — the branch-scoped realtime PTY bridge / navigator API) also take
 * a scope target. `resolveAgentTerminalById`/`killAgentTerminalById` are
 * LEVEL-AGNOSTIC — keyed purely on the row's own id, exactly like PurePoint's
 * `Attach{agent_id}` (`Manifest::find_agent` searches root + every worktree by
 * id, no location path needed): once an agent terminal exists, attaching to
 * or killing it never requires re-supplying which scope it lives in.
 *
 * `spawnAgentTerminal` only reserves the (scope, name, agentType) tracking
 * row — it does NOT eagerly open the Sprite exec session, and (for
 * machine/project scope) does NOT acquire the Machine's Sprite either, since
 * that Sprite is provisioned/reconnected elsewhere (the Terminal page's own
 * shell, or a page-agent's "own machine" tool calls). The actual PTY is
 * created lazily by the realtime bridge on first connect (mirrors how a
 * Terminal page's shell is never opened until a socket connects — see
 * `apps/realtime/src/terminal/terminal-handler.ts`), which then persists the
 * discovered/created Sprite session id back via `updateStreamSessionId` so a
 * later reconnect can reattach instead of spawning a duplicate process.
 * Resolving/killing DOES need a live sandbox: a branch's Sprite is looked up
 * directly (by name or by id), but machine/project scope goes through the
 * injected `machineSandbox.acquire` (the same `acquireMachineSandbox`-backed
 * path a Terminal page shell uses) since that Sprite may need to be
 * reconnected or resumed from hibernation.
 */

import { type MachineHandle, type MachineHost } from '../sandbox/machine-host';
import { SANDBOX_ROOT } from '../sandbox/sandbox-paths';
import { BRANCH_REPO_PATH } from './machine-branches';
import { PROJECT_REPO_PATH, isPromotedProject } from './machine-project-promotion';
import {
  isUniqueViolation,
  type MachineAgentTerminalStore,
  type MachineAgentTerminalRecord,
  type AgentTerminalScopeKey,
  type AgentTerminalScope,
  deriveAgentTerminalScope,
} from './agent-terminals-store';
import {
  isValidAgentTerminalName,
  isValidAgentTerminalCommand,
  isAgentRuntimeType,
  isPtyAgentType,
  type AgentRuntimeType,
} from './agent-terminal-types';

export type { AgentTerminalScopeKey, AgentTerminalScope };
export { deriveAgentTerminalScope };

/** The minimal slice of the Branches store this module needs — resolving a branch's Sprite (`sandboxId`) either by (project, branch) name or by the branch row's OWN id. */
export interface AgentTerminalBranchLookup {
  findByName(machineId: string, projectName: string, branchName: string): Promise<{ id: string; sandboxId: string } | null>;
  /** Level-agnostic lookup, used by the id-keyed resolve/kill path — no project/branch name required. */
  findById(machineBranchId: string): Promise<{ sandboxId: string } | null>;
}

/**
 * The minimal slice of the Projects store this module needs — a project's
 * clone path on the machine's filesystem, PLUS the promotion identity that
 * says whether it still lives there at all.
 *
 * `sandboxId`/`spriteTornDownAt` are optional so a caller wiring an older
 * `{ path }`-only lookup still type-checks; absent reads as UNPROMOTED, which
 * is the pre-promotion behaviour byte-for-byte.
 */
export interface AgentTerminalProjectLookup {
  findByName(
    machineId: string,
    name: string,
  ): Promise<{ path: string; sandboxId?: string | null; spriteTornDownAt?: Date | null } | null>;
}

/**
 * LAZY PROMOTION's trigger seam (issue #2204 phase 7). A project is a checkout
 * on the owning Machine's Sprite until the first project-scoped spawn promotes
 * it to its own; `spawnAgentTerminal` is where that spawn happens, so it is
 * where the promotion fires — inline, before the row is reserved.
 *
 * Injected rather than imported so this module keeps its narrow, store-shaped
 * deps: `promoteProject` needs a `MachineHost`, an egress gate, a GitHub token
 * resolver and a full actor context, none of which spawning otherwise touches.
 * Optional — a caller that omits it (a branch-only consumer, a test) gets the
 * pre-promotion behaviour byte-for-byte.
 */
export interface AgentTerminalProjectPromotion {
  promote(input: { machineId: string; projectName: string }): Promise<
    { ok: true } | { ok: false; reason: string; detail?: string }
  >;
}

export type AgentTerminalMachineSandboxResult =
  | { ok: true; sandboxId: string }
  | { ok: false; reason: string };

/** Acquires the OWNING Machine's persistent Sprite (machine/project scope share this one Sprite) — see `services/sandbox/machine-session.ts` for the production implementation. */
export interface AgentTerminalMachineSandbox {
  acquire(machineId: string): Promise<AgentTerminalMachineSandboxResult>;
}

export interface AgentTerminalsDeps {
  branchStore: AgentTerminalBranchLookup;
  /** Required only for project/machine-scope targets — a branch-only caller (today's only wired consumer) never needs it. */
  projectStore?: AgentTerminalProjectLookup;
  /** Required only for project/machine-scope targets. */
  machineSandbox?: AgentTerminalMachineSandbox;
  /** Lazy project-Sprite promotion, fired by a project-scoped spawn — see `AgentTerminalProjectPromotion`. */
  projectPromotion?: AgentTerminalProjectPromotion;
  store: MachineAgentTerminalStore;
  host: MachineHost;
  now: () => Date;
}

/** Each function below asks for exactly the slice of `AgentTerminalsDeps` it touches — e.g. a read-only resolver never needs `host`, so a caller (like the realtime PTY bridge) doesn't have to fabricate one just to satisfy the type. */
export type SpawnAgentTerminalDeps = Pick<
  AgentTerminalsDeps,
  'branchStore' | 'projectStore' | 'store' | 'now' | 'projectPromotion'
>;
export type ResolveAgentTerminalDeps = Pick<AgentTerminalsDeps, 'branchStore' | 'projectStore' | 'machineSandbox' | 'store'>;
export type ListAgentTerminalsDeps = Pick<AgentTerminalsDeps, 'branchStore' | 'projectStore' | 'store'>;
export type KillAgentTerminalDeps = Pick<AgentTerminalsDeps, 'branchStore' | 'projectStore' | 'machineSandbox' | 'store' | 'host'>;

export interface AgentTerminalActor {
  userId: string;
}

/**
 * `projectName`/`branchName` together select the scope: neither set →
 * machine, `projectName` only → project, both set → branch. `branchName`
 * without `projectName` is not a valid target (a branch always belongs to a
 * named project) and is rejected as `invalid_target`.
 */
export interface AgentTerminalTarget {
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
}

export type AgentTerminalScopeDenialReason =
  | 'invalid_target'
  | 'project_not_found'
  | 'branch_not_found'
  | 'machine_unavailable'
  /** A project/machine-scope target was requested but the caller's deps didn't wire `projectStore`/`machineSandbox`. */
  | 'scope_unsupported';

type ScopeKeyResolution =
  | { ok: true; scopeKey: AgentTerminalScopeKey }
  | { ok: false; reason: 'invalid_target' | 'project_not_found' | 'branch_not_found' | 'scope_unsupported' };

/** Resolve WHICH scope row a target addresses, without touching any Sprite — enough for spawn/list. */
async function resolveScopeKey({
  machineId,
  projectName,
  branchName,
  deps,
}: {
  machineId: string;
  projectName?: string;
  branchName?: string;
  deps: Pick<AgentTerminalsDeps, 'branchStore' | 'projectStore'>;
}): Promise<ScopeKeyResolution> {
  if (branchName !== undefined) {
    if (!projectName) return { ok: false, reason: 'invalid_target' };
    const branch = await deps.branchStore.findByName(machineId, projectName, branchName);
    if (!branch) return { ok: false, reason: 'branch_not_found' };
    return { ok: true, scopeKey: { machineId, projectName, machineBranchId: branch.id } };
  }

  if (projectName !== undefined) {
    if (!deps.projectStore) return { ok: false, reason: 'scope_unsupported' };
    const project = await deps.projectStore.findByName(machineId, projectName);
    if (!project) return { ok: false, reason: 'project_not_found' };
    return { ok: true, scopeKey: { machineId, projectName, machineBranchId: null } };
  }

  return { ok: true, scopeKey: { machineId, projectName: null, machineBranchId: null } };
}

type LocationResolution =
  | {
      ok: true;
      sandboxId: string;
      cwd: string;
      /**
       * Does this node run on its OWN Sprite (a branch, or a PROMOTED project)
       * rather than the owning Machine's shared one? Consumers that must treat
       * "own Sprite" differently — the realtime bridge's Claude-credential
       * refresh, which only makes sense for a Sprite that does not already
       * carry the user's own login — key off THIS, never off the shape of the
       * (projectName, branchName) target, which cannot tell a promoted project
       * from an unpromoted one.
       */
      ownSprite: boolean;
    }
  | { ok: false; reason: AgentTerminalScopeDenialReason };

/**
 * Shared project/machine-scope location resolution, PROMOTED-FIRST.
 *
 * A project that has been promoted (issue #2204 phase 7,
 * `machine-project-promotion.ts`) has its OWN Sprite and its repo at
 * `PROJECT_REPO_PATH` — so it resolves exactly like a branch does, and never
 * acquires the machine's Sprite at all. An UNPROMOTED project (and machine
 * scope itself) is unchanged: the machine's own Sprite, addressed by `cwd`.
 */
async function resolveProjectOrMachineLocation({
  machineId,
  projectName,
  deps,
}: {
  machineId: string;
  projectName: string | null;
  deps: Pick<AgentTerminalsDeps, 'projectStore' | 'machineSandbox'>;
}): Promise<LocationResolution> {
  let cwd = SANDBOX_ROOT;
  if (projectName !== null) {
    if (!deps.projectStore) return { ok: false, reason: 'scope_unsupported' };
    const project = await deps.projectStore.findByName(machineId, projectName);
    if (!project) return { ok: false, reason: 'project_not_found' };
    // Promoted-first: check BEFORE falling through to the machine acquire, so a
    // promoted project never wakes (or bills the wake of) a Sprite it no longer
    // lives on.
    if (project.sandboxId && !project.spriteTornDownAt) {
      return { ok: true, sandboxId: project.sandboxId, cwd: PROJECT_REPO_PATH, ownSprite: true };
    }
    cwd = project.path;
  }

  if (!deps.machineSandbox) return { ok: false, reason: 'scope_unsupported' };
  const acquired = await deps.machineSandbox.acquire(machineId);
  if (!acquired.ok) return { ok: false, reason: 'machine_unavailable' };
  return { ok: true, sandboxId: acquired.sandboxId, cwd, ownSprite: false };
}

/** Resolve WHERE an already-known ROW's Sprite + working directory live, by its OWN scope columns — the level-agnostic path (no name lookup at all). */
async function resolveLocationForRow(
  row: Pick<MachineAgentTerminalRecord, 'machineId' | 'projectName' | 'machineBranchId'>,
  deps: Pick<AgentTerminalsDeps, 'branchStore' | 'projectStore' | 'machineSandbox'>,
): Promise<LocationResolution> {
  if (row.machineBranchId) {
    const branch = await deps.branchStore.findById(row.machineBranchId);
    if (!branch) return { ok: false, reason: 'branch_not_found' };
    return { ok: true, sandboxId: branch.sandboxId, cwd: BRANCH_REPO_PATH, ownSprite: true };
  }
  return resolveProjectOrMachineLocation({ machineId: row.machineId, projectName: row.projectName, deps });
}

export type SpawnAgentTerminalDenialReason =
  | 'invalid_name'
  | 'invalid_agent_type'
  | 'invalid_command'
  | AgentTerminalScopeDenialReason
  /**
   * A project-scoped spawn could not promote its project to its own Sprite —
   * most often the dirty-tree refusal, whose `detail` tells the user exactly
   * what to commit or discard. Deliberately a FAILED SPAWN rather than a
   * fallback to the machine Sprite: promotion reclaims the machine-side
   * checkout, so a session silently born there would be pointing at a
   * directory the next successful promotion deletes.
   */
  | 'promotion_failed'
  | 'name_in_use'
  | 'error';

/** Pure decision: is this (name, agentType, command?) safe to reserve as an agent terminal? */
export function planSpawnAgentTerminal(input: { name: string; agentType: string; command?: string }):
  | { ok: true }
  | { ok: false; reason: 'invalid_name' | 'invalid_agent_type' | 'invalid_command' } {
  if (!isValidAgentTerminalName(input.name)) return { ok: false, reason: 'invalid_name' };
  if (!isAgentRuntimeType(input.agentType)) return { ok: false, reason: 'invalid_agent_type' };
  if (input.command !== undefined && !isValidAgentTerminalCommand(input.command)) {
    return { ok: false, reason: 'invalid_command' };
  }
  return { ok: true };
}

export type SpawnAgentTerminalResult =
  | { ok: true; id: string; agentType: AgentRuntimeType; resumed: boolean }
  /** `detail` carries a promotion refusal's actionable message; absent for every other denial. */
  | { ok: false; reason: SpawnAgentTerminalDenialReason; detail?: string };

/**
 * Promote this project to its OWN Sprite if it has not been promoted yet.
 *
 * Idempotent and race-safe by construction: the promotion itself persists under
 * a compare-and-swap (`MachineProjectStore.promote`), so two concurrent spawns
 * of the same project cannot both win — the loser adopts the winner's Sprite
 * instead of orphaning its own. The cheap `isPromotedProject` pre-check here is
 * purely to avoid paying for a redundant attach on the overwhelmingly common
 * already-promoted path; correctness does not depend on it.
 */
async function ensureProjectPromoted({
  machineId,
  projectName,
  deps,
}: {
  machineId: string;
  projectName: string;
  deps: Pick<AgentTerminalsDeps, 'projectStore' | 'projectPromotion'>;
}): Promise<{ ok: true } | { ok: false; reason: 'promotion_failed'; detail?: string }> {
  if (!deps.projectPromotion || !deps.projectStore) return { ok: true };

  const project = await deps.projectStore.findByName(machineId, projectName);
  // A missing row is not this function's failure to report — `resolveScopeKey`
  // already denied it as `project_not_found` before we got here.
  if (!project) return { ok: true };
  if (isPromotedProject({ sandboxId: project.sandboxId ?? null, spriteTornDownAt: project.spriteTornDownAt ?? null })) {
    return { ok: true };
  }

  const promoted = await deps.projectPromotion.promote({ machineId, projectName });
  if (promoted.ok) return { ok: true };
  return { ok: false, reason: 'promotion_failed', detail: promoted.detail ?? promoted.reason };
}

/**
 * Spawn (or resume) a named agent terminal at a scope. Idempotent by (scope,
 * name) with the SAME agentType — a second call for an already-reserved name
 * returns the existing reservation instead of erroring; reusing the name
 * under a DIFFERENT agentType is rejected (`name_in_use`) rather than
 * silently repurposing an existing session's identity. `command` (an
 * optional program override, PurePoint `AgentEntry.command` parity) is only
 * consulted on a FRESH reservation — a resume reattaches to whatever the
 * original spawn already fixed.
 */
export async function spawnAgentTerminal({
  machineId,
  projectName,
  branchName,
  name,
  agentType,
  command,
  actor,
  deps,
}: AgentTerminalTarget & { agentType: string; command?: string; actor: AgentTerminalActor; deps: SpawnAgentTerminalDeps }): Promise<SpawnAgentTerminalResult> {
  const plan = planSpawnAgentTerminal({ name, agentType, command });
  if (!plan.ok) return plan;
  const resolvedType = agentType as AgentRuntimeType;

  const scope = await resolveScopeKey({ machineId, projectName, branchName, deps });
  if (!scope.ok) return scope;

  // LAZY PROMOTION, at its trigger. Only true PROJECT scope: a branch already
  // has its own Sprite whatever its project's state, and machine scope IS the
  // machine's Sprite. Runs BEFORE the row is reserved, so a refused promotion
  // leaves nothing behind pointing at a checkout the next successful promotion
  // would reclaim.
  if (scope.scopeKey.projectName !== null && scope.scopeKey.machineBranchId === null) {
    const promoted = await ensureProjectPromoted({
      machineId: scope.scopeKey.machineId,
      projectName: scope.scopeKey.projectName,
      deps,
    });
    if (!promoted.ok) return promoted;
  }

  const existing = await deps.store.findByName(scope.scopeKey, name);
  if (existing) {
    if (existing.agentType !== resolvedType) return { ok: false, reason: 'name_in_use' };
    return { ok: true, id: existing.id, agentType: resolvedType, resumed: true };
  }

  try {
    const row = await deps.store.create({
      ownerId: actor.userId,
      machineId: scope.scopeKey.machineId,
      scope: deriveAgentTerminalScope(scope.scopeKey),
      projectName: scope.scopeKey.projectName,
      machineBranchId: scope.scopeKey.machineBranchId,
      name,
      agentType: resolvedType,
      command: command ?? null,
      now: deps.now(),
    });
    return { ok: true, id: row.id, agentType: resolvedType, resumed: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Lost a race against a concurrent spawn of the same name.
      const reconciled = await deps.store.findByName(scope.scopeKey, name);
      if (reconciled && reconciled.agentType === resolvedType) {
        return { ok: true, id: reconciled.id, agentType: resolvedType, resumed: true };
      }
      if (reconciled) return { ok: false, reason: 'name_in_use' };
    }
    return { ok: false, reason: 'error' };
  }
}

export type ResolveAgentTerminalResult =
  | {
      ok: true;
      agentTerminalId: string;
      sandboxId: string;
      cwd: string;
      /** True when this terminal runs on the node's OWN Sprite — a branch, or a PROMOTED project. See `LocationResolution.ownSprite`. */
      ownSprite: boolean;
      agentType: AgentRuntimeType;
      command: string | null;
      streamSessionId: string | null;
    }
  | { ok: false; reason: AgentTerminalScopeDenialReason | 'not_found' | 'not_a_pty_agent' };

/**
 * Is this row's agentType valid AND does it actually spawn a PTY (as opposed
 * to a `'chat'`-surface type like `pagespace`)? Every resolve/kill path that
 * would otherwise wake or attach a Sprite must run this check FIRST — a row
 * nothing can ever launch a PTY on has no business touching a Sprite at all.
 */
function checkPtyAgentRow(
  row: Pick<MachineAgentTerminalRecord, 'agentType'>,
): { ok: true; agentType: AgentRuntimeType } | { ok: false; reason: 'not_found' | 'not_a_pty_agent' } {
  if (!isAgentRuntimeType(row.agentType)) return { ok: false, reason: 'not_found' };
  if (!isPtyAgentType(row.agentType)) return { ok: false, reason: 'not_a_pty_agent' };
  return { ok: true, agentType: row.agentType };
}

function toResolveResult(
  row: MachineAgentTerminalRecord,
  agentType: AgentRuntimeType,
  location: { sandboxId: string; cwd: string; ownSprite: boolean },
): ResolveAgentTerminalResult {
  return {
    ok: true,
    agentTerminalId: row.id,
    sandboxId: location.sandboxId,
    cwd: location.cwd,
    ownSprite: location.ownSprite,
    agentType,
    command: row.command,
    streamSessionId: row.streamSessionId,
  };
}

export type ResolveAgentTerminalRowResult =
  | { ok: true; agentTerminalId: string; agentType: AgentRuntimeType }
  | { ok: false; reason: AgentTerminalScopeDenialReason | 'not_found' | 'not_a_pty_agent' };

export type ResolveAgentTerminalRowDeps = Pick<AgentTerminalsDeps, 'branchStore' | 'projectStore' | 'store'>;

/**
 * Does this (scope, name) target still EXIST? A purely relational existence
 * check — `resolveScopeKey` (branch/project row lookups) plus the agent-terminal
 * row itself — that resolves NO Sprite and wakes nothing.
 *
 * Split out of `resolveAgentTerminal` because that function fuses two very
 * differently-priced questions: "does this row exist" (a couple of indexed
 * reads) and "where does its Sprite live" (which, for machine/project scope,
 * goes through `machineSandbox.acquire` and can RECONNECT OR RESUME a
 * hibernated Sprite). Callers that only need to re-validate a target — the
 * realtime bridge's 60s re-auth tick, and its reattach path — must ask the
 * cheap question alone: asking the expensive one on a timer is what kept idle
 * Sprites awake, and asking it on a tab-back is what made tab-backs slow.
 *
 * `agentType` is validated here (an unrecognized one reads as `not_found`,
 * matching `toResolveResult`) so a corrupt row is caught by the existence check
 * rather than surviving to the launch path.
 */
export async function resolveAgentTerminalRow({
  machineId,
  projectName,
  branchName,
  name,
  deps,
}: AgentTerminalTarget & { deps: ResolveAgentTerminalRowDeps }): Promise<ResolveAgentTerminalRowResult> {
  const scope = await resolveScopeKey({ machineId, projectName, branchName, deps });
  if (!scope.ok) return scope;

  const row = await deps.store.findByName(scope.scopeKey, name);
  if (!row) return { ok: false, reason: 'not_found' };
  const check = checkPtyAgentRow(row);
  if (!check.ok) return check;
  return { ok: true, agentTerminalId: row.id, agentType: check.agentType };
}

/**
 * Resolve a named agent terminal down to what the realtime PTY bridge needs
 * to open (or reattach) its stream: which Sprite (`sandboxId`), which working
 * directory (`cwd`), which launch spec (`agentType`/`command`), and any
 * already-known Sprite session id to reattach to. Read-only for branch scope
 * (never provisions); for machine/project scope it may reconnect/resume the
 * Machine's Sprite via `machineSandbox.acquire`, since that Sprite can be
 * hibernating.
 */
export async function resolveAgentTerminal({
  machineId,
  projectName,
  branchName,
  name,
  deps,
}: AgentTerminalTarget & { deps: ResolveAgentTerminalDeps }): Promise<ResolveAgentTerminalResult> {
  const scope = await resolveScopeKey({ machineId, projectName, branchName, deps });
  if (!scope.ok) return scope;

  const row = await deps.store.findByName(scope.scopeKey, name);
  if (!row) return { ok: false, reason: 'not_found' };
  const check = checkPtyAgentRow(row);
  if (!check.ok) return check;

  const location = await resolveLocationForRow(row, deps);
  if (!location.ok) return location;
  return toResolveResult(row, check.agentType, location);
}

/**
 * Level-agnostic resolve, keyed PURELY on the agent terminal's own id —
 * mirrors PurePoint's `Attach{agent_id}` (`Manifest::find_agent` searches
 * root + every worktree by id; no scope path needed). The row's own
 * `projectName`/`machineBranchId` columns tell us where its Sprite lives.
 *
 * PERFORMS NO ACCESS CHECK — unlike the by-name path (whose callers already
 * hold a `machineId` from the request and check page access to it BEFORE
 * calling in), a by-id caller only learns which page a row belongs to AFTER
 * this resolves. No route wires this today; whoever adds one MUST check the
 * caller's access to the *resolved* `row.machineId` (e.g. via
 * `packages/lib/src/permissions/`) before trusting or acting on the result.
 */
export async function resolveAgentTerminalById({
  agentTerminalId,
  deps,
}: {
  agentTerminalId: string;
  deps: ResolveAgentTerminalDeps;
}): Promise<ResolveAgentTerminalResult> {
  const row = await deps.store.findById(agentTerminalId);
  if (!row) return { ok: false, reason: 'not_found' };
  const check = checkPtyAgentRow(row);
  if (!check.ok) return check;

  const location = await resolveLocationForRow(row, deps);
  if (!location.ok) return location;
  return toResolveResult(row, check.agentType, location);
}

export async function listAgentTerminals({
  machineId,
  projectName,
  branchName,
  deps,
}: {
  machineId: string;
  projectName?: string;
  branchName?: string;
  deps: ListAgentTerminalsDeps;
}): Promise<{ ok: true; terminals: MachineAgentTerminalRecord[] } | { ok: false; reason: 'invalid_target' | 'project_not_found' | 'branch_not_found' | 'scope_unsupported' }> {
  const scope = await resolveScopeKey({ machineId, projectName, branchName, deps });
  if (!scope.ok) return scope;
  // Deliberately UNFILTERED — a row whose agentType predates a since-retired
  // AGENT_LAUNCH_SPECS entry (e.g. the removed 'pagespace-cli') is still listed.
  // Dropping it here would make it undiscoverable: DELETE kills by name, and the
  // navigator's "unclaimed session" adopt flow is the only way a name the local
  // workspace store doesn't already know about ever resurfaces (see
  // `WorkspaceLeaves.tsx`). Hiding it would strand the row (and any live PTY/
  // billing session under it) with no path to clean it up. Callers distinguish
  // "listed" from "launchable" via `isAgentRuntimeType(row.agentType)` themselves
  // (the API route does this — see `agent-terminals/route.ts`); the actual launch
  // path (`resolveAgentTerminal`/`resolveAgentTerminalRow`, below) still refuses
  // to hand an invalid agentType to `resolveAgentLaunchSpec`.
  const terminals = await deps.store.list(scope.scopeKey);
  return { ok: true, terminals };
}

export type KillAgentTerminalResult = { ok: true } | { ok: false; reason: AgentTerminalScopeDenialReason | 'not_found' | 'error' };

async function killAtLocation(
  row: MachineAgentTerminalRecord,
  location: { sandboxId: string },
  deps: Pick<AgentTerminalsDeps, 'store' | 'host'>,
): Promise<KillAgentTerminalResult> {
  if (row.streamSessionId) {
    let handle: MachineHandle | null;
    try {
      handle = await deps.host.attach({ machineId: location.sandboxId });
    } catch {
      // The control plane itself is unreachable — we learned NOTHING about the
      // process. Keep the row so a retry can find it again.
      return { ok: false, reason: 'error' };
    }

    if (handle) {
      try {
        // The REST kill-by-id endpoint (`MachineHandle.killSession`, backed by
        // sprites.dev's `POST .../exec/{session_id}/kill`) reaches this session
        // whether or not we hold a live stream to it, and is idempotent against
        // an already-dead/unknown id — see its doc. That retires the old
        // open-a-stream-then-signal dance entirely: a signal only reaches the
        // remote process while that stream's own socket happens to be open, so
        // it needed a `listStreams()` corroboration fallback to tell "already
        // gone" apart from "machine didn't answer." None of that is needed once
        // the kill call itself answers authoritatively.
        await handle.killSession(row.streamSessionId);
      } catch {
        // A genuine failure (control-plane outage, auth) — the kill call
        // already resolves successfully for a session it no longer recognizes,
        // so anything that reaches here is a real unknown. Keep the row so a
        // retry can find it again; deleting it now would strand a possibly
        // still-running, billable process with nothing pointing at it.
        return { ok: false, reason: 'error' };
      }
    }
  }

  await deps.store.remove({ machineId: row.machineId, projectName: row.projectName, machineBranchId: row.machineBranchId }, row.name);
  return { ok: true };
}

/**
 * A row with `streamSessionId === null` (a chat-surface row, which never has
 * one, or a PTY row whose stream was never opened) has nothing running to
 * kill — drop it with a DB-only write, no Sprite touch at all. Only a row
 * whose PTY IS running needs its scope's Sprite resolved (which, for
 * machine/project scope, may acquire/reconnect it) before `killAtLocation`
 * can reach in and kill that specific session.
 */
async function killRow(row: MachineAgentTerminalRecord, deps: KillAgentTerminalDeps): Promise<KillAgentTerminalResult> {
  if (row.streamSessionId === null) {
    await deps.store.remove({ machineId: row.machineId, projectName: row.projectName, machineBranchId: row.machineBranchId }, row.name);
    return { ok: true };
  }

  const location = await resolveLocationForRow(row, deps);
  if (!location.ok) return location;
  return killAtLocation(row, location, deps);
}

/**
 * Tear down a named agent terminal: if its process was ever actually
 * launched (`streamSessionId` set), attach the scope's Sprite through the
 * `MachineHost` seam and kill that specific PTY session, then drop the
 * tracking row. A vanished Sprite has nothing left to kill, so the row is
 * still dropped rather than orphaned; a live Sprite that fails to kill its
 * session keeps the row so a retry can find it again.
 */
export async function killAgentTerminal({
  machineId,
  projectName,
  branchName,
  name,
  deps,
}: AgentTerminalTarget & { deps: KillAgentTerminalDeps }): Promise<KillAgentTerminalResult> {
  const scope = await resolveScopeKey({ machineId, projectName, branchName, deps });
  if (!scope.ok) return scope;

  const row = await deps.store.findByName(scope.scopeKey, name);
  if (!row) return { ok: false, reason: 'not_found' };

  return killRow(row, deps);
}

/**
 * Level-agnostic kill, keyed PURELY on the agent terminal's own id — same
 * PurePoint `Attach{agent_id}` parity as `resolveAgentTerminalById`.
 *
 * PERFORMS NO ACCESS CHECK — see the identical warning on
 * `resolveAgentTerminalById`. A future caller MUST authorize against the
 * resolved row's `machineId` itself; this function will happily kill any
 * agent terminal on the machine's Sprite given only its id.
 */
export async function killAgentTerminalById({
  agentTerminalId,
  deps,
}: {
  agentTerminalId: string;
  deps: KillAgentTerminalDeps;
}): Promise<KillAgentTerminalResult> {
  const row = await deps.store.findById(agentTerminalId);
  if (!row) return { ok: false, reason: 'not_found' };

  return killRow(row, deps);
}
