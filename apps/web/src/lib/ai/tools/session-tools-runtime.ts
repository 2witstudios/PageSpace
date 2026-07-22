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
import {
  createWorkspace,
  updateWorkspace,
  removeWorkspace,
  listWorkspaces,
} from '@pagespace/lib/services/machines/machine-workspaces';
import {
  buildSpawnAgentTerminalDeps,
  buildListAgentTerminalsDeps,
  buildKillAgentTerminalDeps,
} from '@/lib/machines/agent-terminals-runtime';
import { buildMachineWorkspacesDeps, toWorkspaceDTO } from '@/lib/machines/machine-workspaces-runtime';
import { broadcastMachineWorkspaceEvent } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createSessionTools, type SessionToolsDeps } from './session-tools';
import type { SessionView, SessionViewWrite } from './session-layout';

/** A node's `{projectName?, branchName?}` half, as the agent-terminal API takes it. */
function scopeArgs(node: { project?: string; branch?: string }): { projectName?: string; branchName?: string } {
  return {
    ...(node.project ? { projectName: node.project } : {}),
    ...(node.branch ? { branchName: node.branch } : {}),
  };
}

/**
 * Apply one planned layout write through the same service call the human UI's
 * route makes, then broadcast the same event with the same payload shape. A
 * failed write is logged and skipped rather than thrown: the session itself
 * already exists (or is already gone), and taking the whole tool call down
 * over a layout row would leave the model believing nothing happened at all.
 */
async function applyWrite(
  machineId: string,
  write: SessionViewWrite,
  actor: { userId: string },
): Promise<void> {
  const deps = buildMachineWorkspacesDeps();

  if (write.kind === 'create') {
    const result = await createWorkspace({
      machineId,
      ownerId: actor.userId,
      id: write.id,
      name: write.name,
      scope: write.scope,
      layout: { columns: write.columns },
      deps,
    });
    if (!result.ok) {
      loggers.ai.warn('session-tools: workspace create rejected', { machineId, reason: result.reason });
      return;
    }
    // Only a genuine insert broadcasts `created`: `createWorkspace` is a
    // first-writer-wins upsert-by-id, and re-announcing an existing row as new
    // would append a duplicate to every browser's sidebar order.
    if (result.created) {
      void broadcastMachineWorkspaceEvent(machineId, 'machine-workspace:created', {
        machineId,
        ...toWorkspaceDTO(result.workspace),
      });
    }
    return;
  }

  if (write.kind === 'update') {
    const result = await updateWorkspace({
      machineId,
      workspaceId: write.id,
      layout: { columns: write.columns },
      deps,
    });
    if (!result.ok) {
      loggers.ai.warn('session-tools: workspace update rejected', { machineId, reason: result.reason });
      return;
    }
    // Columns only — the same partial-PATCH discipline the client uses, so a
    // concurrent rename in a browser is never clobbered by a stale name.
    void broadcastMachineWorkspaceEvent(machineId, 'machine-workspace:updated', {
      machineId,
      workspaceId: write.id,
      columns: result.workspace.layout.columns,
    });
    return;
  }

  const result = await removeWorkspace({ machineId, workspaceId: write.id, store: deps.store });
  if (!result.ok) {
    loggers.ai.warn('session-tools: workspace remove rejected', { machineId, reason: result.reason });
    return;
  }
  void broadcastMachineWorkspaceEvent(machineId, 'machine-workspace:deleted', {
    machineId,
    workspaceId: write.id,
  });
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
      return result.terminals.map((row) => ({
        name: row.name,
        agentType: row.agentType,
        streamSessionId: row.streamSessionId,
        updatedAt: row.updatedAt,
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
      return row
        ? {
            name: row.name,
            agentType: row.agentType,
            streamSessionId: row.streamSessionId,
            updatedAt: row.updatedAt,
          }
        : null;
    },

    spawnSession: async ({ node, name, agentType, userId }) => {
      const result = await spawnAgentTerminal({
        machineId: node.machineId,
        ...scopeArgs(node),
        name,
        agentType,
        actor: { userId },
        deps: buildSpawnAgentTerminalDeps(),
      });
      return result.ok ? { ok: true, id: result.id, resumed: result.resumed } : { ok: false, reason: result.reason };
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
      const rows = await listWorkspaces({ machineId, store: deps.store });
      return rows.map(
        (row): SessionView => ({
          id: row.id,
          name: row.name,
          projectName: row.projectName,
          branchName: row.branchName,
          columns: row.layout.columns,
        }),
      );
    },

    applyViewWrites: async (machineId, writes, actor) => {
      // Sequential, in plan order: a move's removal must land before its
      // placement so no browser ever sees the same session claimed twice.
      for (const write of writes) {
        await applyWrite(machineId, write, actor);
      }
    },

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
