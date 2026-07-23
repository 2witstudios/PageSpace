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
 * persistent Sprite session — the SAME `acquireMachineSession`-backed path a
 * Terminal page shell and Machine Projects (`machine-projects-runtime.ts`)
 * already reconnect to — re-authorizing the CURRENT actor (resume re-authz) on
 * every acquire, never trusting a permission check cached from an earlier
 * request. `branchStore.findById` needs no such threading (a branch lookup by
 * its own row id carries no actor context either way).
 *
 * Acquiring never WAKES the Sprite: there is no wake API, and a hibernated
 * Sprite wakes on any incoming request (docs.sprites.dev/concepts/lifecycle), so
 * the kill path's own `attachSession` is the wake.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages, drives } from '@pagespace/db/schema/core';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { decideFullEgressEnablement, isContainmentVerified } from '@pagespace/lib/services/sandbox/containment';
import {
  acquireMachineSession,
  createDbMachineSessionStore,
  getSandboxSessionSecret,
} from '@pagespace/lib/services/sandbox/machine-session-manager';
import { checkMachineRuntimeGuardrail, recordMachineActivity } from '@pagespace/lib/services/sandbox/quota';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';
import { createDbMachineAgentTerminalStore } from '@pagespace/lib/services/machines/agent-terminals-store';
import { createDbMachineProjectStore } from '@pagespace/lib/services/machines/machine-projects-store';
import type {
  SpawnAgentTerminalDeps,
  ListAgentTerminalsDeps,
  KillAgentTerminalDeps,
  AgentTerminalProjectLookup,
  AgentTerminalMachineSandbox,
  AgentTerminalLiveSessions,
} from '@pagespace/lib/services/machines/agent-terminals';
import { promoteProject } from '@pagespace/lib/services/machines/machine-project-promotion';
import { canAccessMachine, canViewMachine, getMachineHostForBranches, resolveRootMachineHandle } from './machine-branches-runtime';
import { buildPromoteProjectDeps, resolveMachineActorContext } from './machine-projects-runtime';

export { canAccessMachine, canViewMachine, isCodeExecutionEnabled };

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

let machineSessionStorePromise: ReturnType<typeof createDbMachineSessionStore> | null = null;
function getMachineSessionStore() {
  machineSessionStorePromise ??= createDbMachineSessionStore();
  return machineSessionStorePromise;
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
      findByName: async (machineId, projectName, branchName) =>
        (await getMachineBranchStore()).findByName(machineId, projectName, branchName),
      findById: async (id) => (await getMachineBranchStore()).findById(id),
    },
    store: {
      list: async (scope) => (await getMachineAgentTerminalStore()).list(scope),
      findByName: async (scope, name) => (await getMachineAgentTerminalStore()).findByName(scope, name),
      findById: async (id) => (await getMachineAgentTerminalStore()).findById(id),
      create: async (input) => (await getMachineAgentTerminalStore()).create(input),
      updateStreamSessionId: async (input) => (await getMachineAgentTerminalStore()).updateStreamSessionId(input),
      recordColdTail: async (input) => (await getMachineAgentTerminalStore()).recordColdTail(input),
      remove: async (scope, name) => (await getMachineAgentTerminalStore()).remove(scope, name),
    },
  };
}

function buildProjectStoreLookup(): AgentTerminalProjectLookup {
  return {
    findByName: async (machineId, name) => (await getMachineProjectStore()).findByName(machineId, name),
  };
}

/** Acquires the OWNING Machine's persistent Sprite, re-authorizing `actorUserId` (resume re-authz) on every call — see module doc. */
function buildMachineSandbox(actorUserId: string): AgentTerminalMachineSandbox {
  return {
    acquire: async (machineId) => {
      const page = await db.query.pages.findFirst({ where: eq(pages.id, machineId), columns: { driveId: true } });
      if (!page) return { ok: false, reason: 'not_found' };
      const drive = await db.query.drives.findFirst({ where: eq(drives.id, page.driveId), columns: { ownerId: true } });
      if (!drive) return { ok: false, reason: 'error' };

      const canRun = isCodeExecutionEnabled() && (await canAccessMachine(actorUserId, machineId));

      const nowMs = Date.now();
      if (canRun) {
        const guardrail = checkMachineRuntimeGuardrail({ machineKey: machineId, now: nowMs });
        if (!guardrail.allowed) return { ok: false, reason: guardrail.reason };
      }

      const result = await acquireMachineSession({
        pageId: machineId,
        driveId: page.driveId,
        tenantId: drive.ownerId,
        userId: actorUserId,
        canRun,
        deps: {
          store: await getMachineSessionStore(),
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

      // NO wake exec here, and no second getSprite to run one with. A Sprite has no
      // explicit wake API — an incoming request wakes it automatically
      // (docs.sprites.dev/concepts/lifecycle) — so whatever the caller does next IS
      // the wake: killAgentTerminal's `host.attach` -> `stream` opens an
      // `attachSession` WebSocket, which wakes the VM exactly like an exec does. The
      // `sh -c :` this used to run first just paid for a second cold start. Mirrors
      // apps/realtime/src/index.ts's buildMachineSandbox.
      recordMachineActivity({ machineKey: machineId, now: nowMs });
      return { ok: true, sandboxId: result.sandboxId };
    },
  };
}

/**
 * Spawn deps, including LAZY PROJECT PROMOTION (issue #2204 phase 7): a
 * project-scoped spawn on an unpromoted project promotes it to its own Sprite
 * first, then reserves the row — so the session it creates resolves onto that
 * Sprite rather than the machine checkout the promotion is about to reclaim.
 *
 * `actorUserId` is required for exactly that: promotion provisions a billable
 * VM, clones through the acting user's GitHub token, and re-checks page access
 * on every machine acquire it makes, so it needs a real actor, not just the
 * row-owner id spawn otherwise carries. The actor context is resolved LAZILY,
 * inside the seam — a machine- or branch-scope spawn never promotes and must
 * not pay for the lookup.
 */
/**
 * The machine Sprite's currently-running PTY session ids, or `null` when we
 * could not find out (issue #2204 follow-up review, Codex P2).
 *
 * ATTACH-ONLY, deliberately: this asks whether a promotion would strand a live
 * process, and waking a hibernating Sprite to answer that would both cost money
 * and make the answer trivially "nothing is running" anyway. A machine with no
 * live Sprite has no live PTY, which is the empty list — not an unknown.
 */
function buildLiveSessions(): AgentTerminalLiveSessions {
  return {
    list: async (machineId) => {
      try {
        // `resolveRootMachineHandle`, NOT `acquire`: the acquire path goes
        // through `getOrCreate`, which wakes a hibernating VM and re-provisions
        // a destroyed one. Paying that to ask "is anything running?" would be
        // absurd — and the answer for a machine we had to create is trivially
        // "no". This resolver looks up a LIVE session id and attaches, or
        // returns null when there is none.
        const handle = await resolveRootMachineHandle(machineId);
        // No live Sprite means no live PTY. That is an empty list, not an
        // unknown — the caller must not fail closed on it.
        if (!handle) return [];
        return (await handle.listStreams()).map((session) => session.id);
      } catch {
        // Control plane unreachable — we learned nothing. The caller fails closed.
        return null;
      }
    },
  };
}

export function buildSpawnAgentTerminalDeps(actorUserId: string): SpawnAgentTerminalDeps {
  return {
    ...buildBaseDeps(),
    projectStore: buildProjectStoreLookup(),
    liveSessions: buildLiveSessions(),
    now: () => new Date(),
    projectPromotion: {
      promote: async ({ machineId, projectName }) => {
        const actor = await resolveMachineActorContext(actorUserId);
        const result = await promoteProject({
          machineId,
          projectName,
          actor,
          deps: buildPromoteProjectDeps({ actorUserId }),
        });
        return result.ok ? { ok: true } : { ok: false, reason: result.reason, detail: result.detail };
      },
    },
  };
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
