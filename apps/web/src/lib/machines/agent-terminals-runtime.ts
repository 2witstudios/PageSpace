/**
 * Production wiring for Agent Terminals (Terminal — Workspace, Runtime tier).
 *
 * Binds the provider-agnostic orchestration (`@pagespace/lib/services/machines/
 * agent-terminals`) to the real DB stores. Access is governed by the OWNING
 * Machine's Terminal page — reuses `canAccessMachine`/`canViewMachine` from
 * the Branches runtime (`./machine-branches-runtime`) rather than duplicating
 * that permission check, since an agent terminal is scoped under the same
 * page. Killing an agent terminal is the one operation that drives a Sprite
 * directly (a branch's own, or — for machine/project scope — the owning
 * Machine's persistent one), so only it (and resolving) needs the Sprite
 * seams; spawning/listing never provision or touch the Sprite.
 *
 * `projectStore` resolves a project's clone path (shared by project- and
 * machine-scope targets); `machineSandbox` acquires the OWNING Machine's
 * persistent Sprite session — the SAME `acquireTerminalSandbox`-backed path a
 * Terminal page shell and Machine Projects (`machine-projects-runtime.ts`)
 * already reconnect to — re-authorizing the CURRENT actor (resume re-authz) on
 * every acquire, never trusting a permission check cached from an earlier
 * request. `branchStore.findById` needs no such threading (a branch lookup by
 * its own row id carries no actor context either way).
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages, drives } from '@pagespace/db/schema/core';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { decideFullEgressEnablement, isContainmentVerified } from '@pagespace/lib/services/sandbox/containment';
import {
  acquireTerminalSandbox,
  createDbTerminalSessionStore,
  getSandboxSessionSecret,
} from '@pagespace/lib/services/sandbox/terminal-session-manager';
import { checkMachineRuntimeGuardrail, recordMachineActivity } from '@pagespace/lib/services/sandbox/quota';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';
import { createDbMachineAgentTerminalStore } from '@pagespace/lib/services/machines/agent-terminals-store';
import { createDbMachineProjectStore } from '@pagespace/lib/services/machines/machine-projects-store';
import type {
  SpawnAgentTerminalDeps,
  ResolveAgentTerminalDeps,
  ListAgentTerminalsDeps,
  KillAgentTerminalDeps,
  AgentTerminalProjectLookup,
  AgentTerminalMachineSandbox,
} from '@pagespace/lib/services/machines/agent-terminals';
import { canAccessMachine, canViewMachine, getMachineHostForBranches } from './machine-branches-runtime';

export { canAccessMachine, canViewMachine };

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one —
// @fly/sprites is ESM-only and @pagespace/lib compiles to CJS. Mirrors the
// same guard as machine-projects-runtime.ts / machine-branches-runtime.ts.
const MIN_SANDBOX_NODE_MAJOR = 24;

function assertSandboxRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < MIN_SANDBOX_NODE_MAJOR) {
    throw new Error(
      `Machine sandbox access requires Node.js >= ${MIN_SANDBOX_NODE_MAJOR} ` +
        `(the @fly/sprites SDK is Node ${MIN_SANDBOX_NODE_MAJOR}+ / ESM-only); ` +
        `this process is Node ${process.versions.node}.`,
    );
  }
}

let sandboxClientPromise: Promise<ExecSandboxClient> | null = null;
function getSandboxClient(): Promise<ExecSandboxClient> {
  sandboxClientPromise ??= (async () => {
    assertSandboxRuntime();
    const { createProductionSpritesSandboxClient } = await import('@/lib/sandbox/sprites-client');
    return createProductionSpritesSandboxClient();
  })().catch((error) => {
    sandboxClientPromise = null;
    throw error;
  });
  return sandboxClientPromise;
}

let terminalSessionStorePromise: ReturnType<typeof createDbTerminalSessionStore> | null = null;
function getTerminalSessionStore() {
  terminalSessionStorePromise ??= createDbTerminalSessionStore();
  return terminalSessionStorePromise;
}

let branchStorePromise: ReturnType<typeof createDbMachineBranchStore> | null = null;
function getMachineBranchStore() {
  branchStorePromise ??= createDbMachineBranchStore();
  return branchStorePromise;
}

let agentTerminalStorePromise: ReturnType<typeof createDbMachineAgentTerminalStore> | null = null;
function getMachineAgentTerminalStore() {
  agentTerminalStorePromise ??= createDbMachineAgentTerminalStore();
  return agentTerminalStorePromise;
}

let machineProjectStorePromise: ReturnType<typeof createDbMachineProjectStore> | null = null;
function getMachineProjectStore() {
  machineProjectStorePromise ??= createDbMachineProjectStore();
  return machineProjectStorePromise;
}

/** The shared (branchStore, store) slice every agent-terminal deps variant is built from. */
function buildBaseDeps(): Pick<SpawnAgentTerminalDeps & KillAgentTerminalDeps, 'branchStore' | 'store'> {
  return {
    branchStore: {
      findByName: async (terminalId, projectName, branchName) =>
        (await getMachineBranchStore()).findByName(terminalId, projectName, branchName),
      findById: async (id) => (await getMachineBranchStore()).findById(id),
    },
    store: {
      list: async (scope) => (await getMachineAgentTerminalStore()).list(scope),
      findByName: async (scope, name) => (await getMachineAgentTerminalStore()).findByName(scope, name),
      findById: async (id) => (await getMachineAgentTerminalStore()).findById(id),
      create: async (input) => (await getMachineAgentTerminalStore()).create(input),
      updateStreamSessionId: async (input) => (await getMachineAgentTerminalStore()).updateStreamSessionId(input),
      remove: async (scope, name) => (await getMachineAgentTerminalStore()).remove(scope, name),
    },
  };
}

function buildProjectStoreLookup(): AgentTerminalProjectLookup {
  return {
    findByName: async (terminalId, name) => (await getMachineProjectStore()).findByName(terminalId, name),
  };
}

/** Acquires the OWNING Machine's persistent Sprite, re-authorizing `actorUserId` (resume re-authz) on every call — see module doc. */
function buildMachineSandbox(actorUserId: string): AgentTerminalMachineSandbox {
  return {
    acquire: async (terminalId) => {
      const page = await db.query.pages.findFirst({ where: eq(pages.id, terminalId), columns: { driveId: true } });
      if (!page) return { ok: false, reason: 'not_found' };
      const drive = await db.query.drives.findFirst({ where: eq(drives.id, page.driveId), columns: { ownerId: true } });
      if (!drive) return { ok: false, reason: 'error' };

      const canRun = isCodeExecutionEnabled() && (await canAccessMachine(actorUserId, terminalId));

      const nowMs = Date.now();
      if (canRun) {
        const guardrail = checkMachineRuntimeGuardrail({ machineKey: terminalId, now: nowMs });
        if (!guardrail.allowed) return { ok: false, reason: guardrail.reason };
      }

      const result = await acquireTerminalSandbox({
        pageId: terminalId,
        driveId: page.driveId,
        tenantId: drive.ownerId,
        userId: actorUserId,
        canRun,
        deps: {
          store: await getTerminalSessionStore(),
          client: await getSandboxClient(),
          now: () => new Date(),
          secret: getSandboxSessionSecret(),
          checkFullEgressEnablement: async () =>
            decideFullEgressEnablement({
              adminGateEnabled: isCodeExecutionEnabled(),
              containment: isContainmentVerified() ? { contained: true } : null,
            }),
        },
      });

      if (!result.ok) return { ok: false, reason: result.reason };
      recordMachineActivity({ machineKey: terminalId, now: nowMs });
      return { ok: true, sandboxId: result.sandboxId };
    },
  };
}

export function buildSpawnAgentTerminalDeps(): SpawnAgentTerminalDeps {
  return { ...buildBaseDeps(), projectStore: buildProjectStoreLookup(), now: () => new Date() };
}

export function buildResolveAgentTerminalDeps(actorUserId: string): ResolveAgentTerminalDeps {
  return { ...buildBaseDeps(), projectStore: buildProjectStoreLookup(), machineSandbox: buildMachineSandbox(actorUserId) };
}

export function buildListAgentTerminalsDeps(): ListAgentTerminalsDeps {
  return { ...buildBaseDeps(), projectStore: buildProjectStoreLookup() };
}

export async function buildKillAgentTerminalDeps(actorUserId: string): Promise<KillAgentTerminalDeps> {
  return {
    ...buildBaseDeps(),
    projectStore: buildProjectStoreLookup(),
    machineSandbox: buildMachineSandbox(actorUserId),
    host: await getMachineHostForBranches(),
  };
}
