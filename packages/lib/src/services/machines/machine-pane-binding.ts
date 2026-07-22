/**
 * Machine Pane binding: pure core (IO injected, no DB, no clock).
 *
 * The "PageSpace Agent" pane type (issue #2166) reuses `POST /api/ai/chat` in
 * DEFAULT mode with `conversationId := machine_agent_terminals.id` — a
 * `pagespace`-typed agent-terminal row IS the pane's identity. This module
 * derives that row into the server-authoritative binding that pins the run's
 * default-mode code-exec tools (bash/readFile/writeFile/editFile) to the
 * right machine checkout, mirroring `resolveLocationForRow` in
 * `agent-terminals.ts` (same branch → project → machine dispatch, by the
 * row's own nullable scope columns) but for the pane's tool-context seam
 * instead of the realtime PTY bridge.
 *
 * The binding is not a single checkout but a HANDLE SET — the bound node plus
 * its downward closure (`MachineNodeHandleSet`). A machine-root pane can
 * address any project or branch beneath it; a project pane, only its own
 * branches; a branch pane, only itself. Everything downstream authorizes
 * against that one set, so sibling isolation is a property of the derivation
 * rather than a rule anyone can forget to apply.
 *
 * `chatId` (the Machine page id the client claims to be talking to) is
 * checked against the resolved row's OWN `machineId` — never trusted from the
 * row alone — because `conversationId` is client-suppliable and a stale or
 * forged pairing must not silently bind tools to a DIFFERENT machine than the
 * pane the user is actually looking at.
 */

import type { MachineAgentTerminalStore } from './agent-terminals-store';
import { SANDBOX_ROOT } from '../sandbox/sandbox-paths';
import { BRANCH_REPO_PATH } from './machine-branches';
import { isAgentRuntimeType, isPtyAgentType } from './agent-terminal-types';

export type MachinePaneBindingFailureReason = 'binding_page_mismatch' | 'project_not_found' | 'branch_not_found';

export interface MachinePaneBindingBranchSandbox {
  machineBranchId: string;
  sandboxId: string;
}

/** Machine / Project / Branch — the three node kinds of a machine's tree. */
export type MachineNodeKind = 'machine' | 'project' | 'branch';

/**
 * ONE addressable node of a machine tree, paired with its RESOLUTION — how a
 * tool call at that node actually runs:
 *  - `branchSandbox` present → the node has its own Sprite; the call attaches
 *    to it (attach-only branch seam) and runs at `cwd` inside it.
 *  - `branchSandbox` absent → the node lives on the MACHINE's own persistent
 *    Sprite and is addressed purely by `cwd`. An unpromoted project is exactly
 *    this case (machine Sprite + `cwd = project.path`), which is what makes the
 *    cascade fully functional before lazy project-Sprite promotion exists.
 *
 * `machineId` rides on every handle because it is the OWNING MACHINE PAGE ID —
 * the runtime-guardrail/payer key. Addressing a node deeper in the tree never
 * moves the money: a branch-targeted run still bills the machine page.
 */
export interface MachineNodeHandle {
  kind: MachineNodeKind;
  /** The owning Machine page id — billing/budget key for every node in the tree. */
  machineId: string;
  /** Project name; undefined only for the machine root. */
  project?: string;
  /** Branch name; defined only for `kind: 'branch'`. */
  branch?: string;
  /** Working directory for a call at this node. */
  cwd: string;
  /** The node's own Sprite, when it has one. Absent → the machine's Sprite. */
  branchSandbox?: MachinePaneBindingBranchSandbox;
}

/**
 * A bound conversation's DOWNWARD CLOSURE: the node it lives at plus every
 * node beneath it. Machine → [self + all projects + all branches]; project →
 * [self + its own branches]; branch → [self].
 *
 * This set is the single authorization fact for the whole machine tool
 * surface. Sibling isolation is NOT a check anywhere downstream — a sibling
 * node is simply never derived, so there is nothing to deny. Everything that
 * needs to authorize a node (the `isMachineAccessible` policy site, `open()`'s
 * `target` resolution) asks THIS set and nothing else.
 */
export interface MachineNodeHandleSet {
  /** The node this conversation is natively bound to. Always `handles[0]`. */
  self: MachineNodeHandle;
  /** self + the downward closure, self first, then depth-first by project. */
  handles: readonly MachineNodeHandle[];
}

export type MachinePaneBinding = MachineNodeHandleSet;

/** A `target` argument from a tool call: a node addressed relative to the bound node. */
export interface MachineNodeTarget {
  project?: string;
  branch?: string;
}

export type MachineNodeTargetResolution =
  | { ok: true; handle: MachineNodeHandle }
  /** The addressed node is not in the derived set (a sibling, or simply gone). */
  | { ok: false; reason: 'target_not_in_set' }
  /** A bare branch name that exists under more than one project in the set. */
  | { ok: false; reason: 'ambiguous_target' };

/**
 * Resolve a tool call's `target` against a derived handle set. PURE LOOKUP —
 * it makes no policy decision of its own, because the set already IS the
 * policy (see `MachineNodeHandleSet`): "not in the set" is the same fact as
 * "never derived", so there is no second place that can decide differently.
 *
 * An omitted `target` (or an empty one) is the node the conversation is
 * natively bound to. A bare `branch` defaults its project to `self.project`
 * when self is inside one; from the machine root a bare branch name resolves
 * only when it is unambiguous across the whole set, so two projects sharing a
 * branch name can never silently route to the wrong one.
 */
export function resolveMachineNodeTarget(
  set: MachineNodeHandleSet,
  target: MachineNodeTarget | undefined,
): MachineNodeTargetResolution {
  if (!target || (!target.project && !target.branch)) return { ok: true, handle: set.self };

  if (target.branch) {
    const project = target.project ?? set.self.project;
    const matches = set.handles.filter(
      (h) => h.kind === 'branch' && h.branch === target.branch && (project === undefined || h.project === project),
    );
    if (matches.length === 1) return { ok: true, handle: matches[0] };
    return { ok: false, reason: matches.length === 0 ? 'target_not_in_set' : 'ambiguous_target' };
  }

  const project = set.handles.find((h) => h.kind === 'project' && h.project === target.project);
  return project ? { ok: true, handle: project } : { ok: false, reason: 'target_not_in_set' };
}

export type MachinePaneBindingResult =
  | null
  | { ok: true; binding: MachinePaneBinding }
  | { ok: false; reason: MachinePaneBindingFailureReason };

export interface DeriveMachinePaneBindingInput {
  /** The Machine page id the client claims this pane belongs to. */
  chatId: string;
  /** The agent-terminal row id (`machine_agent_terminals.id`) backing this pane. */
  conversationId: string;
}

/** A project row as this module sees it: its name and its clone path on the machine's filesystem. */
export interface MachinePaneBindingProject {
  name: string;
  path: string;
}

/** A branch row as this module sees it: its identity, its Sprite, and whether that Sprite is confirmed destroyed. */
export interface MachinePaneBindingBranch {
  id: string;
  projectName: string;
  branchName: string;
  sandboxId: string;
  spriteTornDownAt: Date | null;
}

/** The minimal slice of the Projects store this module needs — the bound project, plus the machine's whole project list for a machine-root cascade. */
export interface MachinePaneBindingProjectLookup {
  findByName(machineId: string, name: string): Promise<MachinePaneBindingProject | null>;
  list(machineId: string): Promise<MachinePaneBindingProject[]>;
}

/** The minimal slice of the Branches store this module needs — the bound branch, plus a project's branch list for the cascade. */
export interface MachinePaneBindingBranchLookup {
  findById(machineBranchId: string): Promise<MachinePaneBindingBranch | null>;
  list(machineId: string, projectName: string): Promise<MachinePaneBindingBranch[]>;
}

export interface DeriveMachinePaneBindingDeps {
  terminalStore: Pick<MachineAgentTerminalStore, 'findById'>;
  projectLookup: MachinePaneBindingProjectLookup;
  branchLookup: MachinePaneBindingBranchLookup;
}

/**
 * Derive the machine-pane tool binding for a conversation, or `null` when
 * this conversation isn't a machine-bound PageSpace Agent pane at all — no
 * row, an unrecognized/retired `agentType` (e.g. `pagespace-cli`), or a
 * `'pty'`-surface type (`shell`/`claude`/`codex`) whose own conversation is
 * never machine-bound. Uses `isAgentRuntimeType`/`isPtyAgentType`
 * (`agent-terminal-types.ts`) rather than comparing against a hardcoded
 * `'pagespace'` literal, per that module's own doc comment — this stays
 * correct if a future `'chat'`-surface type joins the registry. A resolved
 * chat-surface row that fails page-identity or scope-existence checks fails
 * CLOSED (`ok: false`) rather than falling back to an unbound run.
 *
 * PERFORMS NO ACCESS CHECK on `input.chatId` itself (mirrors the same
 * explicit caveat on `resolveAgentTerminalById` in `agent-terminals.ts`) —
 * the `binding_page_mismatch` check only verifies that the resolved row is
 * INTERNALLY CONSISTENT with the `chatId` the caller supplied, not that the
 * caller is entitled to that machine. Whoever wires the actual call site
 * (issue #2166 phases 6/7) MUST authorize the acting user against `chatId`
 * BEFORE calling this — the same way the chat route already authorizes page
 * access for every request.
 */
export async function deriveMachinePaneBinding(
  input: DeriveMachinePaneBindingInput,
  deps: DeriveMachinePaneBindingDeps,
): Promise<MachinePaneBindingResult> {
  const row = await deps.terminalStore.findById(input.conversationId);
  if (!row) return null;
  if (!isAgentRuntimeType(row.agentType)) return null;
  if (isPtyAgentType(row.agentType)) return null;
  if (row.machineId !== input.chatId) return { ok: false, reason: 'binding_page_mismatch' };

  if (row.machineBranchId) {
    const branch = await deps.branchLookup.findById(row.machineBranchId);
    if (!branch || branch.spriteTornDownAt !== null) return { ok: false, reason: 'branch_not_found' };
    // A branch is a leaf: its downward closure is itself. Sibling branches of
    // the same project are not derived, so they are unaddressable — no denial
    // rule required anywhere downstream.
    const self = branchHandle(row.machineId, branch);
    return { ok: true, binding: { self, handles: [self] } };
  }

  if (row.projectName) {
    const project = await deps.projectLookup.findByName(row.machineId, row.projectName);
    if (!project) return { ok: false, reason: 'project_not_found' };
    const self = projectHandle(row.machineId, project);
    return { ok: true, binding: { self, handles: [self, ...(await branchHandles(row.machineId, project, deps))] } };
  }

  const self: MachineNodeHandle = { kind: 'machine', machineId: row.machineId, cwd: SANDBOX_ROOT };
  const projects = await deps.projectLookup.list(row.machineId);
  // Depth-first, in the store's own project order: each project immediately
  // followed by its branches. Order is part of the contract only insofar as
  // self is first (see `MachineNodeHandleSet`); the rest is display sanity.
  const descendants = await Promise.all(
    projects.map(async (project) => [
      projectHandle(row.machineId, project),
      ...(await branchHandles(row.machineId, project, deps)),
    ]),
  );
  return { ok: true, binding: { self, handles: [self, ...descendants.flat()] } };
}

function projectHandle(machineId: string, project: MachinePaneBindingProject): MachineNodeHandle {
  // No `branchSandbox`: an UNPROMOTED project is a checkout on the machine's
  // own Sprite, addressed by cwd alone. Lazy project-Sprite promotion (the
  // later epic phase) adds one here without changing any consumer.
  return { kind: 'project', machineId, project: project.name, cwd: project.path };
}

function branchHandle(machineId: string, branch: MachinePaneBindingBranch): MachineNodeHandle {
  return {
    kind: 'branch',
    machineId,
    project: branch.projectName,
    branch: branch.branchName,
    cwd: BRANCH_REPO_PATH,
    branchSandbox: { machineBranchId: branch.id, sandboxId: branch.sandboxId },
  };
}

/**
 * The live branches of one project. A branch whose Sprite is CONFIRMED
 * destroyed (`spriteTornDownAt`) is omitted rather than derived-then-denied:
 * that is the same fail-closed rule the natively-bound branch path applies
 * (`branch_not_found`), expressed as absence from the set. A torn-down branch
 * is unaddressable from anywhere.
 */
async function branchHandles(
  machineId: string,
  project: MachinePaneBindingProject,
  deps: DeriveMachinePaneBindingDeps,
): Promise<MachineNodeHandle[]> {
  const branches = await deps.branchLookup.list(machineId, project.name);
  return branches.filter((b) => b.spriteTornDownAt === null).map((b) => branchHandle(machineId, b));
}
