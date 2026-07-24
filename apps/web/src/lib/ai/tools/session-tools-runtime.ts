/**
 * Production wiring for the session family.
 *
 * Binds the provider-agnostic factory (`createSessionTools`) to the real
 * implementations: the agent-terminal orchestration in `@pagespace/lib`
 * (spawn/list/kill, already wired by `machines/agent-terminals-runtime.ts`)
 * and the Machine Workspaces service (the same `createWorkspace`/
 * `updateWorkspace`/`removeWorkspace` + broadcast path the human UI's
 * `/api/machines/workspaces` routes go through).
 *
 * Going through those SAME service functions — rather than writing rows
 * directly — is what keeps the server's writes indistinguishable from a
 * browser's: identical validation, identical `machine-workspace:*` broadcast
 * vocabulary, so every open Machine page reconciles an agent's spawn exactly
 * as it reconciles a teammate's.
 *
 * NO ACCESS CHECK lives here. The conversation's derived handle set is the
 * entitlement (established by the chat route's page-edit check before
 * `deriveMachinePaneBinding` ran) and `session-tools.ts` authorizes every node
 * against it; adding a second policy site here is precisely what this epic
 * forbids.
 */

import type { Tool } from 'ai';
import {
  spawnAgentTerminal,
  listAgentTerminals,
  killAgentTerminal,
} from '@pagespace/lib/services/machines/agent-terminals';
import { listWorkspaces } from '@pagespace/lib/services/machines/machine-workspaces';
import { createDbMachinePanesStore } from '@pagespace/lib/services/machines/machine-panes-store';
import {
  buildSpawnAgentTerminalDeps,
  buildListAgentTerminalsDeps,
  buildKillAgentTerminalDeps,
} from '@/lib/machines/agent-terminals-runtime';
import { buildMachineWorkspacesDeps } from '@/lib/machines/machine-workspaces-runtime';
import { applyWorkspaceVerbLocked, broadcastWorkspaceVerbResult } from '@/lib/machines/workspace-verbs-runtime';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { agentSurfaceOf, isAgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import { createSessionTools, type SessionToolsDeps } from './session-tools';
import { readAgentSession, sendAgentSession } from './session-io-agent';
import { readPtyLiveness, readPtySession, sendPtySession } from './session-io-pty';
import type { SessionView } from './session-layout';
import type { WorkspaceVerb } from '@/stores/machine-workspace/workspace-verbs';

/**
 * Which of these sessions have a generation IN FLIGHT right now.
 *
 * One query per node listing, keyed by the conversation ids the rows already
 * carry (a chat-surface row's id IS its conversation id). It answers for BOTH
 * kinds of in-flight generation, because both register the same way: a
 * `send_session` dispatch holding its run-claim, and a human mid-turn in the
 * pane. Heartbeat-authoritative — a row whose process died stops beating and
 * stops counting, so a crashed run never leaves a session reading as busy
 * forever (see `stream-liveness.ts`).
 *
 * This is the `streaming` UPGRADE promised by phase 4's state-read function:
 * it arrives as one more field on `SessionRow`, so `readSessionState` remains
 * the only place a session's state is decided.
 */
async function readStreamingConversationIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try {
    const { db } = await import('@pagespace/db/db');
    const { and, eq, inArray } = await import('@pagespace/db/operators');
    const { aiStreamSessions } = await import('@pagespace/db/schema/ai-streams');
    const { STREAM_HEARTBEAT_STALE_MS } = await import('@/lib/ai/core/stream-liveness');

    const rows = await db
      .select({
        conversationId: aiStreamSessions.conversationId,
        lastHeartbeatAt: aiStreamSessions.lastHeartbeatAt,
      })
      .from(aiStreamSessions)
      .where(and(inArray(aiStreamSessions.conversationId, ids), eq(aiStreamSessions.status, 'streaming')));

    const now = Date.now();
    return new Set(
      rows
        .filter((row) => now - row.lastHeartbeatAt.getTime() <= STREAM_HEARTBEAT_STALE_MS)
        .map((row) => row.conversationId),
    );
  } catch (error) {
    // A listing that fails here still lists every session with its other state
    // intact; reporting nothing as streaming is the conservative degrade (the
    // dispatch itself is refused by the claim regardless of what this said).
    loggers.ai.warn('session-tools: streaming-state read failed', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return new Set();
  }
}

/** A node's `{projectName?, branchName?}` half, as the agent-terminal API takes it. */
function scopeArgs(node: { project?: string; branch?: string }): { projectName?: string; branchName?: string } {
  return {
    ...(node.project ? { projectName: node.project } : {}),
    ...(node.branch ? { branchName: node.branch } : {}),
  };
}

/**
 * Apply one planned verb through the SAME `applyWorkspaceVerb` engine
 * `POST /api/machines/workspaces/verbs` uses, then broadcast the same
 * verb+rev event (plus the legacy vocabulary — see its module doc). A failed
 * verb is logged and skipped rather than thrown: the session itself already
 * exists (or is already gone), and taking the whole tool call down over a
 * layout row would leave the model believing nothing happened at all.
 */
async function applyVerb(machineId: string, verb: WorkspaceVerb, actor: { userId: string }): Promise<void> {
  const result = await applyWorkspaceVerbLocked(machineId, verb, actor.userId);
  if (!result.ok) {
    loggers.ai.warn('session-tools: workspace verb rejected', { machineId, verb: verb.type, reason: result.reason });
    return;
  }
  broadcastWorkspaceVerbResult(machineId, verb, result);
}

export function buildSessionToolsDeps(): SessionToolsDeps {
  return {
    listSessions: async (node) => {
      const result = await listAgentTerminals({
        machineId: node.machineId,
        ...scopeArgs(node),
        deps: buildListAgentTerminalsDeps(),
      });
      if (!result.ok) return [];
      // Only chat-surface rows can have a conversation to stream on; a PTY row's
      // id is never a conversation id, so asking about it would be meaningless.
      const streaming = await readStreamingConversationIds(
        result.terminals
          .filter((row) => isAgentRuntimeType(row.agentType) && agentSurfaceOf(row.agentType) === 'chat')
          .map((row) => row.id),
      );
      return result.terminals.map((row) => ({
        name: row.name,
        agentType: row.agentType,
        streamSessionId: row.streamSessionId,
        coldTail: row.coldTail,
        coldTailAt: row.coldTailAt,
        coldTailHasOutput: row.coldTailHasOutput,
        updatedAt: row.updatedAt,
        streaming: streaming.has(row.id),
      }));
    },

    // Deliberately a filtered list rather than a second by-name lookup: the
    // scope key a name lookup needs (`machineBranchId`, not the branch NAME)
    // is exactly what `listAgentTerminals` already resolves, and re-deriving
    // it here would be a second copy of that resolution.
    findSession: async (node, name) => {
      const result = await listAgentTerminals({
        machineId: node.machineId,
        ...scopeArgs(node),
        deps: buildListAgentTerminalsDeps(),
      });
      if (!result.ok) return null;
      const row = result.terminals.find((candidate) => candidate.name === name);
      if (!row) return null;
      const streaming =
        isAgentRuntimeType(row.agentType) && agentSurfaceOf(row.agentType) === 'chat'
          ? (await readStreamingConversationIds([row.id])).has(row.id)
          : false;
      return {
        name: row.name,
        agentType: row.agentType,
        streamSessionId: row.streamSessionId,
        coldTail: row.coldTail,
        coldTailAt: row.coldTailAt,
        coldTailHasOutput: row.coldTailHasOutput,
        updatedAt: row.updatedAt,
        streaming,
      };
    },

    spawnSession: async ({ node, name, agentType, userId }) => {
      const result = await spawnAgentTerminal({
        machineId: node.machineId,
        ...scopeArgs(node),
        name,
        agentType,
        actor: { userId },
        deps: buildSpawnAgentTerminalDeps(userId),
      });
      // A promotion refusal's `detail` is the actionable half of the message —
      // an agent told only `promotion_failed` cannot tell the user what to fix.
      return result.ok
        ? { ok: true, id: result.id, resumed: result.resumed }
        : { ok: false, reason: result.detail ? `${result.reason}: ${result.detail}` : result.reason };
    },

    killSession: async ({ node, name, userId }) => {
      const result = await killAgentTerminal({
        machineId: node.machineId,
        ...scopeArgs(node),
        name,
        deps: await buildKillAgentTerminalDeps(userId),
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },

    listViews: async (machineId) => {
      const deps = buildMachineWorkspacesDeps();
      const [rows, grids] = await Promise.all([
        listWorkspaces({ machineId, store: deps.store }),
        (await createDbMachinePanesStore()).getMachineGrids(machineId),
      ]);
      return rows.map(
        (row): SessionView => ({
          id: row.id,
          name: row.name,
          projectName: row.projectName,
          branchName: row.branchName,
          columns: grids.get(row.id) ?? [],
        }),
      );
    },

    applyVerbs: async (machineId, verbs, actor) => {
      // Sequential, in plan order: a move's removal must land before its
      // placement so no browser ever sees the same session claimed twice.
      for (const verb of verbs) {
        await applyVerb(machineId, verb, actor);
      }
    },

    // One module per surface, each owned end-to-end by its own phase. The
    // dispatch decision itself lives in `session-tools.ts` (by the row's own
    // agent type); this is only the wiring.
    io: {
      agent: { read: readAgentSession, send: sendAgentSession },
      pty: { read: readPtySession, send: sendPtySession },
    },

    // The realtime service owns the PTYs, so it is the only thing that knows
    // which shells are actually running. Same signed endpoint `read_session`
    // uses, asked for liveness only.
    ptyLiveness: readPtyLiveness,

    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  };
}

/**
 * The session family, fully wired. Registered by the chat route for
 * machine-BOUND conversations only — see `withSessionFamilyTools`.
 */
export function buildSessionTools(): Record<string, Tool> {
  return createSessionTools(buildSessionToolsDeps());
}
