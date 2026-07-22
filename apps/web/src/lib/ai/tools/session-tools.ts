/**
 * The SESSION FAMILY — a machine-bound agent's whole orchestration surface.
 *
 * `list_sessions` (what nodes exist, what is running in them, and which views
 * they show), `add_session` (spawn + materialize), `move_session` (re-home),
 * `kill_session` (tear down), and the `read_session`/`send_session` IO pair.
 * Together they replace, for a machine-bound conversation, everything the
 * drive-agent surface does with `list_machines`/`switch_machine`/
 * `ask_agent` — none of which a bound conversation gets (see
 * `filterToolsForMachineBinding`, and the MACHINE BINDING prompt block which
 * names `list_sessions` as the one discovery tool).
 *
 * This module is the provider-agnostic FACTORY only: schemas, target
 * resolution, authorization, and the one state-read function. It imports no DB
 * and no backing-provider SDK, so it is unit-tested with injected fakes — the
 * production wiring lives in `session-tools-runtime.ts`, exactly the split
 * `sandbox-tools.ts` / `sandbox-tools-runtime.ts` already use.
 *
 * AUTHORIZATION is set membership and nothing else. Every tool here resolves
 * its `target` through `resolveMachineNodeTarget` against the conversation's
 * derived handle set — the same call `open()` makes in sandbox-tools.ts, and
 * the same fact `isMachineAccessible` enforces for the machine itself. A node
 * this refuses is a node the set never contained. Adding a second place that
 * decides node access is the review failure-mode for this whole epic.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  resolveMachineNodeTarget,
  type MachineNodeHandle,
  type MachineNodeHandleSet,
  type MachineNodeTarget,
} from '@pagespace/lib/services/machines/machine-pane-binding';
import {
  agentSurfaceOf,
  isAgentRuntimeType,
  isValidAgentTerminalName,
  type AgentRuntimeType,
} from '@pagespace/lib/services/machines/agent-terminal-types';
import { autoSessionName, type OpenTerminalScope } from '@/stores/machine-workspace/workspace-reducer';
import type { ToolExecutionContext } from '../core/types';
import { nodeTargetDeniedError, nodeTargetSchema } from './sandbox-tools';
import {
  planPlaceSession,
  viewsAtNode,
  type SessionPlacement,
  type SessionView,
  type SessionViewWrite,
} from './session-layout';

/** The two kinds of session a machine runs: a PageSpace Agent, or a plain shell. */
export type SessionType = 'agent' | 'shell';

/** The agent-terminal type backing each session type — the registry's own keys. */
const AGENT_TYPE_OF: Record<SessionType, AgentRuntimeType> = {
  agent: 'pagespace',
  shell: 'shell',
};

/**
 * A session's lifecycle state, from ONE function (`readSessionState`).
 *
 * Phase 4 derives it from data that already exists — does the row exist, does
 * it have a PTY stream yet, when was it last touched. `'streaming'` (an agent
 * mid-run) and real PTY liveness are UPGRADES BEHIND THIS SAME FUNCTION by the
 * send_session engine and the realtime scrollback endpoints; every consumer
 * reads the state through here, so neither upgrade touches a caller.
 */
export type SessionState = 'reserved' | 'idle' | 'active' | 'streaming';

/** How recently a row must have been touched to read as `active` rather than `idle`. */
export const SESSION_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** The slice of a `machine_agent_terminals` row the session family reads. */
export interface SessionRow {
  name: string;
  agentType: string;
  /** The Sprite exec session its PTY runs under — null until the realtime bridge opens one. */
  streamSessionId: string | null;
  updatedAt: Date;
}

/**
 * THE state-read function. A `'pty'`-surface row with no stream session has
 * never actually started: `add_session` only RESERVES the row and materializes
 * the pane, and the PTY is created lazily by the realtime bridge on first
 * viewer connect. Reporting that honestly as `'reserved'` — rather than as an
 * idle session that simply happens to be quiet — is what keeps a never-started
 * shell from reading as a live one (epic risk register #2). A `'chat'`-surface
 * row never has a stream session at all, so it is never `'reserved'`.
 */
export function readSessionState(row: SessionRow, now: Date): SessionState {
  const surface = isAgentRuntimeType(row.agentType) ? agentSurfaceOf(row.agentType) : 'pty';
  if (surface === 'pty' && row.streamSessionId === null) return 'reserved';
  return now.getTime() - row.updatedAt.getTime() <= SESSION_ACTIVE_WINDOW_MS ? 'active' : 'idle';
}

/** How a session type reads back out of a row — `'other'` for a retired agentType no picker offers. */
function sessionTypeOf(agentType: string): SessionType | 'other' {
  if (!isAgentRuntimeType(agentType)) return 'other';
  return agentSurfaceOf(agentType) === 'chat' ? 'agent' : 'shell';
}

/** The pane surface a session's type renders as — the `kind` a bound pane stores. */
function paneKindOf(agentType: AgentRuntimeType): 'terminal' | 'chat' {
  return agentSurfaceOf(agentType) === 'chat' ? 'chat' : 'terminal';
}

/** A node rendered for the model: stable, unambiguous, and never parsed back. */
export function describeNode(handle: MachineNodeHandle): string {
  switch (handle.kind) {
    case 'machine':
      return 'machine';
    case 'project':
      return `project "${handle.project}"`;
    case 'branch':
      return `project "${handle.project}" / branch "${handle.branch}"`;
  }
}

/** The `{projectName?, branchName?}` half of a node — what every stored row keys on. */
function nodeNames(handle: MachineNodeHandle): { projectName?: string; branchName?: string } {
  return {
    ...(handle.project ? { projectName: handle.project } : {}),
    ...(handle.branch ? { branchName: handle.branch } : {}),
  };
}

/**
 * A session, fully addressed: WHICH node it lives at (the resolved handle —
 * its cwd, its Sprite, and the owning machine page that pays for it) and its
 * name within that node.
 *
 * THE FROZEN CONTRACT of this phase. `read_session`/`send_session` resolve
 * through it here, and the send_session engine and the realtime scrollback/
 * stdin endpoints consume it as-is — so a `{target?, name}` pair means exactly
 * one thing across every surface, resolved in exactly one place.
 */
export interface SessionTerminalIdentity {
  node: MachineNodeHandle;
  name: string;
  /** The agent-terminal row address (`AgentTerminalTarget` minus its deps). */
  address: { machineId: string; projectName?: string; branchName?: string; name: string };
}

export type SessionTargetResolution =
  | { ok: true; identity: SessionTerminalIdentity }
  | { ok: false; error: { success: false; error: string } };

/**
 * Resolve `{target?, name}` to a session identity against the conversation's
 * derived handle set — the single seam phases 5 and 6 build on.
 *
 * `binding` undefined means the conversation is not machine-bound at all, which
 * is a hard refusal rather than a fallback: the session family is registered
 * only for bound conversations, so reaching here unbound means something has
 * gone wrong upstream and answering at "some machine" would be a guess.
 */
export function resolveSessionTarget(
  binding: MachineNodeHandleSet | undefined,
  input: { target?: MachineNodeTarget; name: string },
): SessionTargetResolution {
  if (!binding) return { ok: false, error: unboundError() };
  const resolved = resolveMachineNodeTarget(binding, input.target);
  if (!resolved.ok) return { ok: false, error: nodeTargetDeniedError(resolved.reason, input.target ?? {}) };
  const node = resolved.handle;
  return {
    ok: true,
    identity: {
      node,
      name: input.name,
      address: { machineId: node.machineId, ...nodeNames(node), name: input.name },
    },
  };
}

/** The full session address a pane binds to — node names + name + surface kind. */
function terminalScopeOf(node: MachineNodeHandle, name: string, agentType: AgentRuntimeType): OpenTerminalScope {
  return { ...nodeNames(node), name, kind: paneKindOf(agentType) };
}

function unboundError(): { success: false; error: string } {
  return {
    success: false,
    error:
      'This conversation is not bound to a machine, so it has no sessions to manage. The session tools are only available inside a Machine pane.',
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sessionNameSchema = z.string().min(1).max(100);

const placementSchema = z.union([
  z.literal('new-view'),
  z
    .object({
      /** A workspace id from `list_sessions`' `views` — the addressing key. */
      splitInto: z.string().min(1),
      direction: z.enum(['right', 'down']),
    })
    .strict(),
]);

export const listSessionsInputSchema = z
  .object({ target: nodeTargetSchema.optional() })
  .strict();

export const addSessionInputSchema = z
  .object({
    target: nodeTargetSchema.optional(),
    type: z.enum(['agent', 'shell']),
    name: sessionNameSchema.optional(),
    placement: placementSchema.optional(),
    /** Reserved for the send_session engine — refused until then (see `add_session`). */
    prompt: z.string().min(1).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Injected IO
// ---------------------------------------------------------------------------

export interface SessionSpawnInput {
  node: MachineNodeHandle;
  name: string;
  agentType: AgentRuntimeType;
  userId: string;
}

export type SessionSpawnResult = { ok: true; id: string; resumed: boolean } | { ok: false; reason: string };
export type SessionKillResult = { ok: true } | { ok: false; reason: string };

export interface SessionToolsDeps {
  /** The agent-terminal rows at one node. */
  listSessions: (node: MachineNodeHandle) => Promise<SessionRow[]>;
  /** One row by (node, name), or null. */
  findSession: (node: MachineNodeHandle, name: string) => Promise<SessionRow | null>;
  /** Reserve (or resume) the row — `spawnAgentTerminal`. Never starts a PTY. */
  spawnSession: (input: SessionSpawnInput) => Promise<SessionSpawnResult>;
  /** Tear the row (and any running PTY) down — `killAgentTerminal`. */
  killSession: (input: { node: MachineNodeHandle; name: string; userId: string }) => Promise<SessionKillResult>;
  /** Every view of a machine, in creation order. */
  listViews: (machineId: string) => Promise<SessionView[]>;
  /** Persist AND broadcast the planned layout writes, in order. */
  applyViewWrites: (machineId: string, writes: SessionViewWrite[], actor: { userId: string }) => Promise<void>;
  /** Fresh ids for panes/columns (the layout planner stays pure). */
  newId: () => string;
  now: () => Date;
}

function readContext(options: unknown): ToolExecutionContext | undefined {
  return (options as { experimental_context?: ToolExecutionContext })?.experimental_context;
}

/** The acting user, or a refusal — every session write is attributed to a real user. */
function readActor(context: ToolExecutionContext | undefined): { userId: string } | undefined {
  return context?.userId ? { userId: context.userId } : undefined;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function createSessionTools(deps: SessionToolsDeps): {
  list_sessions: Tool;
  add_session: Tool;
} {
  return {
    list_sessions: tool({
      description:
        'List the machine nodes you can reach (this node and everything beneath it), what is RUNNING in each, and each node\'s views. ' +
        'Every node is listed even when it holds nothing, so this is also how you discover which project/branch names a target may name. ' +
        'A view is a pane grid a human sees; its id is what add_session/move_session\'s placement.splitInto addresses. ' +
        'Session state: reserved (a shell whose PTY starts when a viewer first connects), active, or idle.',
      inputSchema: listSessionsInputSchema,
      execute: async ({ target }, options) => {
        const context = readContext(options);
        const binding = context?.machineBinding;
        if (!binding) return unboundError();

        // A target narrows the listing to ONE node; without one, the whole
        // derived set is reported — which is the same set every other tool
        // authorizes against, so the model never sees a node it cannot address.
        let handles: readonly MachineNodeHandle[] = binding.handles;
        if (target && (target.project || target.branch)) {
          const resolved = resolveMachineNodeTarget(binding, target);
          if (!resolved.ok) return nodeTargetDeniedError(resolved.reason, target);
          handles = [resolved.handle];
        }

        // One view read for the whole machine, partitioned per node below —
        // views are stored per machine, not per node.
        const views = await deps.listViews(binding.self.machineId);
        const now = deps.now();

        const nodes = await Promise.all(
          handles.map(async (handle) => {
            const rows = await deps.listSessions(handle);
            return {
              node: describeNode(handle),
              self: handle === binding.self,
              cwd: handle.cwd,
              views: viewsAtNode(views, nodeNames(handle)).map((view) => ({ id: view.id, name: view.name })),
              sessions: rows.map((row) => ({
                name: row.name,
                type: sessionTypeOf(row.agentType),
                agentType: row.agentType,
                state: readSessionState(row, now),
              })),
            };
          }),
        );

        return { success: true, nodes };
      },
    }),

    add_session: tool({
      description:
        'Start a new session at a node you can reach: type "agent" (a PageSpace Agent, which you can later send work to) or "shell" (a plain terminal). ' +
        'A shell session is RESERVED until a human viewer first connects — its PTY starts then, not now — so it reports state "reserved" and produces no output until someone opens it. ' +
        'placement defaults to "new-view" (the session gets its own view); pass { splitInto: <view id from list_sessions>, direction: "right" | "down" } to put it beside what is already there. ' +
        'A view only ever holds sessions from its own node. Omit name to have one minted for you.',
      inputSchema: addSessionInputSchema,
      execute: async ({ target, type, name, placement, prompt }, options) => {
        const context = readContext(options);
        const actor = readActor(context);
        if (!actor) return { success: false, error: 'Starting a session requires an authenticated user.' };

        // The starting prompt belongs to the agent-dispatch engine (which owns
        // the run-claim and the depth cap). Accepting it here and silently
        // dropping it would look like a delivered instruction that never ran.
        if (prompt !== undefined) {
          return {
            success: false,
            error:
              'add_session cannot deliver a starting prompt yet. Start the session without prompt, then use send_session once it is available.',
          };
        }

        const resolvedName = name ?? autoSessionName(AGENT_TYPE_OF[type], deps.newId());
        if (!isValidAgentTerminalName(resolvedName)) {
          return {
            success: false,
            error: `"${resolvedName}" is not a valid session name — use letters, digits, "-" and "_", starting with a letter or digit.`,
          };
        }

        const resolved = resolveSessionTarget(context?.machineBinding, { target, name: resolvedName });
        if (!resolved.ok) return resolved.error;
        const { node } = resolved.identity;
        const agentType = AGENT_TYPE_OF[type];

        // Reserve the row FIRST: a manifestation pointing at a session that
        // was never reserved is a pane that can never bind.
        const spawned = await deps.spawnSession({ node, name: resolvedName, agentType, userId: actor.userId });
        if (!spawned.ok) {
          return { success: false, error: `Could not start session "${resolvedName}": ${spawned.reason}.` };
        }

        const scope = terminalScopeOf(node, resolvedName, agentType);
        const views = await deps.listViews(node.machineId);
        const plan = planPlaceSession(views, scope, placement ?? 'new-view', {
          paneId: deps.newId(),
          columnId: deps.newId(),
        });
        if (!plan.ok) return placementDeniedError(plan.reason, placement, describeNode(node));

        await deps.applyViewWrites(node.machineId, plan.writes, actor);

        const row = await deps.findSession(node, resolvedName);
        const view = plan.writes.find((write) => write.id === plan.viewId);
        return {
          success: true,
          name: resolvedName,
          type,
          node: describeNode(node),
          resumed: spawned.resumed,
          state: row ? readSessionState(row, deps.now()) : reservedStateFor(agentType),
          view: { id: plan.viewId, name: view && view.kind === 'create' ? view.name : undefined },
        };
      },
    }),
  };
}

/** The state a just-reserved session is in when its row can't be re-read — the honest default. */
function reservedStateFor(agentType: AgentRuntimeType): SessionState {
  return readSessionState({ name: '', agentType, streamSessionId: null, updatedAt: new Date(0) }, new Date(0));
}

/** The tool-facing denial for a placement the machine's views can't satisfy. */
export function placementDeniedError(
  reason: 'view_not_found' | 'cross_node',
  placement: SessionPlacement | undefined,
  node: string,
): { success: false; error: string } {
  const viewId = placement && placement !== 'new-view' ? placement.splitInto : 'that view';
  if (reason === 'view_not_found') {
    return {
      success: false,
      error: `There is no view "${viewId}" on this machine. Call list_sessions to see each node's views and their ids.`,
    };
  }
  return {
    success: false,
    error: `The view "${viewId}" belongs to a different node, and a view only ever holds sessions from its own node (this session is at ${node}). Pick a view at that node, or use placement "new-view".`,
  };
}
