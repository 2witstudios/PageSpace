/**
 * Production wiring for Machine Projects (Terminal — Workspace, Projects tier).
 *
 * Binds the provider-agnostic orchestration (`@pagespace/lib/services/machines/
 * machine-projects`) to the real implementations: the DB-backed project +
 * machine-session stores, the Fly Sprites driver, the quota/audit surface, the
 * GitHub token brokering, and a per-call machine-access re-check (the same
 * resume-re-authz invariant the Terminal sandbox lifecycle enforces — an
 * actor's access to a shared machine is re-verified on every acquire, not
 * cached from an earlier request).
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { decideFullEgressEnablement, isContainmentVerified } from '@pagespace/lib/services/sandbox/containment';
import { getSandboxSessionSecret } from '@pagespace/lib/services/sandbox/session-manager';
import { acquireCodeExecutionSlot, releaseCodeExecutionSlot } from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { defaultBuildEnv } from '@pagespace/lib/services/sandbox/tool-runners';
import { resolveGitHubTokenForSandbox } from '@pagespace/lib/services/sandbox/github-token';
import { isTerminalPage } from '@pagespace/lib/content/page-types.config';
import type { PageType } from '@pagespace/lib/utils/enums';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { canUserEditPage, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import {
  acquireMachineSandbox,
  createDbMachineSessionStore,
} from '@pagespace/lib/services/machines/machine-session-manager';
import { createDbMachineProjectStore } from '@pagespace/lib/services/machines/machine-projects-store';
import { deriveMachineKey, type MachineIdentity } from '@pagespace/lib/services/machines/machine-identity';
import type { MachineActorContext, MachineProjectsDeps } from '@pagespace/lib/services/machines/machine-projects';

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one —
// @fly/sprites is ESM-only and @pagespace/lib compiles to CJS. Mirrors the
// same guard as apps/web/src/lib/ai/tools/sandbox-tools-runtime.ts.
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

let machineProjectStorePromise: ReturnType<typeof createDbMachineProjectStore> | null = null;
function getMachineProjectStore() {
  machineProjectStorePromise ??= createDbMachineProjectStore();
  return machineProjectStorePromise;
}

const VALID_TIERS: ReadonlySet<string> = new Set(['free', 'pro', 'founder', 'business']);
function toTier(value: string | null | undefined): SubscriptionTier {
  return value && VALID_TIERS.has(value) ? (value as SubscriptionTier) : 'free';
}

export async function resolveMachineActorContext(userId: string): Promise<MachineActorContext> {
  const [user, actorInfo] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { subscriptionTier: true } }),
    getActorInfo(userId),
  ]);
  return {
    userId,
    tenantId: userId,
    actorEmail: actorInfo.actorEmail,
    actorDisplayName: actorInfo.actorDisplayName,
    tier: toTier(user?.subscriptionTier),
  };
}

/**
 * Whether `actorUserId` may currently operate on `machine` — re-checked on
 * every acquire (not cached), mirroring the Terminal sandbox's resume
 * re-authz invariant. An 'own' machine is tautologically the actor's own
 * (callers only ever construct it with `ownerId: actorUserId`); an
 * 'existing' machine requires edit access on the Terminal page it names.
 */
export async function canAccessMachine(actorUserId: string, machine: MachineIdentity): Promise<boolean> {
  if (machine.kind === 'own') return true;
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, machine.terminalId),
    columns: { type: true },
  });
  if (!page || !isTerminalPage(page.type as PageType)) return false;
  return canUserEditPage(actorUserId, machine.terminalId);
}

/** View-level access (list) — looser than edit-level (add/remove). */
export async function canViewMachine(actorUserId: string, machine: MachineIdentity): Promise<boolean> {
  if (machine.kind === 'own') return true;
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, machine.terminalId),
    columns: { type: true },
  });
  if (!page || !isTerminalPage(page.type as PageType)) return false;
  return canUserViewPage(actorUserId, machine.terminalId);
}

export function buildMachineProjectsDeps({ actorUserId }: { actorUserId: string }): MachineProjectsDeps {
  return {
    store: {
      list: async (machineKey) => (await getMachineProjectStore()).list(machineKey),
      findByName: async (machineKey, name) => (await getMachineProjectStore()).findByName(machineKey, name),
      create: async (input) => (await getMachineProjectStore()).create(input),
      remove: async (machineKey, name) => (await getMachineProjectStore()).remove(machineKey, name),
    },
    isEnabled: isCodeExecutionEnabled,
    now: () => new Date(),
    acquireMachineSandbox: async (machine) => {
      const canRun = isCodeExecutionEnabled() && (await canAccessMachine(actorUserId, machine));
      return acquireMachineSandbox({
        machineKey: deriveMachineKey(machine),
        tenantId: actorUserId,
        ownerId: actorUserId,
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
    },
    reconnect: async (sandboxId) => (await getSandboxClient()).get({ sandboxId }),
    resolveGitHubToken: (userId) => resolveGitHubTokenForSandbox({ userId, db }),
    quota: {
      acquireSlot: acquireCodeExecutionSlot,
      releaseSlot: releaseCodeExecutionSlot,
    },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
  };
}
