/**
 * Production wiring for the agent code-execution tools.
 *
 * Binds the provider-agnostic factory (`createSandboxTools`) to the real
 * implementations: the DB-backed session store, the Fly Sprites driver, the
 * quota/concurrency surface, the call-time authz/quota gate, the audit writer,
 * and the chat-context → actor resolver. Kept in its own module so the factory
 * (and its tests) never import the backing-provider SDK (`@fly/sprites` is
 * ESM/node24-only).
 *
 * Importing this module does not expose anything: PR4 calls `buildSandboxTools`
 * and registers the result behind the default-OFF feature flag.
 */

import type { Tool } from 'ai';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { drives, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { defaultBuildEnv, type SandboxRunDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { isCodeExecutionEnabled, canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  decideFullEgressEnablement,
  isContainmentVerified,
} from '@pagespace/lib/services/sandbox/containment';
import {
  screenToolOutput,
  heuristicInjectionClassifier,
} from '@pagespace/lib/services/sandbox/injection-seam';
import {
  getSandboxSessionSecret,
  createDbTerminalSessionStore,
} from '@pagespace/lib/services/sandbox/terminal-session-manager';
import { acquireMachineSandbox } from '@pagespace/lib/services/sandbox/machine-session';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  checkMachineRuntimeGuardrail,
  recordMachineActivity,
} from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { gateSandboxToolCall } from '@pagespace/lib/services/sandbox/tool-gate';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isTerminalPage } from '@pagespace/lib/content/page-types.config';
import type { PageType } from '@pagespace/lib/utils/enums';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { createSandboxTools, type MachineDirectoryDeps, type ResolveSandboxContext } from './sandbox-tools';
import { canActorViewPage } from './actor-permissions';
import { pageAgentRepository, type MachineRef } from '@/lib/repositories/page-agent-repository';
import { globalTerminalConfigRepository } from '@/lib/repositories/global-terminal-config-repository';
import type { ToolExecutionContext } from '../core/types';
import { notifyTerminalAgentActivity } from '@/lib/websocket/socket-utils';

// The session store and Sprites client are process-wide singletons: the store
// reconnects to one DB pool and the client is stateless. Both are built lazily
// so importing this module does no DB or SDK work at load.
let storePromise: ReturnType<typeof createDbTerminalSessionStore> | null = null;
let sandboxClientPromise: Promise<ExecSandboxClient> | null = null;

function getStore() {
  storePromise ??= createDbTerminalSessionStore();
  return storePromise;
}

// The Fly Sprites driver is loaded via a DYNAMIC import, never a static one.
// @fly/sprites is ESM-only and @pagespace/lib compiles to CJS, so a static
// import in lib would emit require('@fly/sprites') which Node rejects with
// ERR_REQUIRE_ESM. The factory lives in apps/web/src/lib/sandbox/sprites-client.ts
// instead, where Next.js handles the ESM import correctly. Deferring it here
// also keeps the SDK out of the module graph until code execution is actually
// invoked (only possible once the kill-switch is on).
const MIN_SANDBOX_NODE_MAJOR = 24;

// Deferring the import only protects the OFF path; the ENABLED path still has to
// run on a compatible runtime. Fail CLOSED with an actionable message if a
// Node < 24 process tries to load the SDK, so flipping the flag on a Node 22
// image surfaces the deployment gate ("run the sandbox driver on Node 24+")
// instead of a cryptic ESM/engine failure deep inside the SDK.
function assertSandboxRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < MIN_SANDBOX_NODE_MAJOR) {
    throw new Error(
      `Agent code execution requires Node.js >= ${MIN_SANDBOX_NODE_MAJOR} ` +
        `(the @fly/sprites SDK is Node ${MIN_SANDBOX_NODE_MAJOR}+ / ESM-only); ` +
        `this process is Node ${process.versions.node}. Run the sandbox driver on a ` +
        `Node ${MIN_SANDBOX_NODE_MAJOR}+ runtime before enabling code execution.`,
    );
  }
}

function getSandboxClient(): Promise<ExecSandboxClient> {
  sandboxClientPromise ??= (async () => {
    assertSandboxRuntime();
    const { createProductionSpritesSandboxClient } = await import('@/lib/sandbox/sprites-client');
    return createProductionSpritesSandboxClient();
  })().catch((error) => {
    // Never memoize a rejection: a transient lazy-load failure (or a fixable
    // runtime/version misconfiguration) must not poison every later
    // code-execution request in this process until a restart. Clear the cache so
    // the next call retries the import.
    sandboxClientPromise = null;
    throw error;
  });
  return sandboxClientPromise;
}

/** Wire the real lib deps for the runners (DB-backed store + real Sprites driver). */
export function buildRealSandboxRunDeps(): SandboxRunDeps {
  return {
    isEnabled: isCodeExecutionEnabled,
    acquireSandbox: async (input) =>
      acquireMachineSandbox({
        ...input,
        deps: {
          store: await getStore(),
          client: await getSandboxClient(),
          authorize: canRunCode,
          now: () => new Date(),
          secret: getSandboxSessionSecret(),
          // Full-egress G-gate: the agent sandbox runs OPEN egress, so refuse to
          // provision unless containment is verified for the live topology
          // (SANDBOX_CONTAINMENT_VERIFIED=true after the G1 probes pass). Admin
          // gate has precedence. Fail-closed when unset.
          checkFullEgressEnablement: async () =>
            decideFullEgressEnablement({
              adminGateEnabled: isCodeExecutionEnabled(),
              containment: isContainmentVerified() ? { contained: true } : null,
            }),
          checkMachineRuntimeGuardrail,
          recordMachineActivity,
        },
      }),
    reconnect: async (sandboxId) => (await getSandboxClient()).get({ sandboxId }),
    quota: {
      acquireSlot: acquireCodeExecutionSlot,
      releaseSlot: releaseCodeExecutionSlot,
    },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    // Activity-visibility seam (Terminal Epic 1 T1.5): stream a successful bash
    // run into the referenced Terminal's live PTY feed. Best-effort — errors are
    // handled inside notifyTerminalAgentActivity itself (logged, never thrown).
    notifyTerminalActivity: (input) =>
      notifyTerminalAgentActivity({
        tenantId: input.tenantId,
        driveId: input.driveId,
        pageId: input.pageId,
        command: input.command,
        output: input.output,
        exitCode: input.exitCode,
        agentLabel: input.agentLabel,
      }),
    // Injection seam (DEFENSE-IN-DEPTH, fail-open): screen untrusted tool output
    // through the built-in heuristic classifier before it becomes a model message.
    // Annotates flagged content (never blocks); a classifier error fails open. A
    // model-based classifier can replace `heuristicInjectionClassifier` here.
    screenOutput: (text) =>
      screenToolOutput({
        text,
        classifier: heuristicInjectionClassifier,
        onFlagged: (verdict) =>
          loggers.ai.warn?.('Sandbox tool output flagged by injection seam (annotated, not blocked)', {
            label: verdict.label,
          }),
        onError: (error) =>
          loggers.ai.error(
            'Sandbox injection classifier errored (failing open)',
            error instanceof Error ? error : new Error(String(error)),
          ),
      }),
    now: () => new Date(),
    logger: loggers.ai,
  };
}

const VALID_TIERS: ReadonlySet<string> = new Set(['free', 'pro', 'founder', 'business']);

function toTier(value: string | null | undefined): SubscriptionTier {
  return value && VALID_TIERS.has(value) ? (value as SubscriptionTier) : 'free';
}

/**
 * IO dependencies for resolving the sandbox actor context. Injected so the
 * function can be unit-tested without a real database connection.
 */
export interface ResolveSandboxActorContextDeps {
  findDrive: (driveId: string) => Promise<{ ownerId: string } | undefined>;
  findPageDriveId: (pageId: string) => Promise<string | undefined>;
  findUser: (userId: string) => Promise<{ subscriptionTier: string | null } | undefined>;
  getActorInfo: (userId: string) => Promise<{ actorEmail: string; actorDisplayName?: string }>;
}

const defaultResolveDeps: ResolveSandboxActorContextDeps = {
  findDrive: (driveId) =>
    db.query.drives.findFirst({ where: eq(drives.id, driveId), columns: { ownerId: true } }),
  findPageDriveId: async (pageId) => {
    const row = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true },
    });
    return row?.driveId ?? undefined;
  },
  findUser: (userId) =>
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { subscriptionTier: true } }),
  getActorInfo,
};

/**
 * Factory that creates the actor-context resolver with injected deps. The
 * default export (`resolveSandboxActorContext`) wires the real DB implementations;
 * pass fakes in tests.
 *
 * Discriminates by chatSource.type BEFORE checking driveId — three cases:
 *  - driveId present (page or global): look up drive.ownerId for tenantId.
 *  - page / undefined chatSource, no driveId: fail closed.
 *  - global, no driveId: tenantId = userId (user is their own isolation boundary).
 */
export function createResolveSandboxActorContext(
  deps: ResolveSandboxActorContextDeps = defaultResolveDeps,
): ResolveSandboxContext {
  return async (context) => {
    const userId = context?.userId;
    const conversationId = context?.conversationId;
    if (!userId) return { error: 'Code execution requires an authenticated user.' };
    if (!conversationId) return { error: 'Code execution requires a conversation.' };

    const chatSourceType = context?.chatSource?.type;
    const driveId =
      context?.locationContext?.currentDrive?.id ??
      (
        chatSourceType === 'page' && context?.chatSource?.agentPageId
          ? await deps.findPageDriveId(context.chatSource.agentPageId)
          : undefined
      );

    // Page AI (or undefined chatSource) with no driveId — fail closed. Don't
    // assume global intent when the source type is absent.
    if (chatSourceType !== 'global' && !driveId) {
      return { error: 'Code execution requires an active drive.' };
    }

    // driveId present for both page AI and global AI: resolve tenantId from the
    // drive's owning account. Both surfaces share identical resolution logic here.
    if (driveId) {
      const [drive, actorRow, actorInfo] = await Promise.all([
        deps.findDrive(driveId),
        deps.findUser(userId),
        deps.getActorInfo(userId),
      ]);
      if (!drive) return { error: 'Code execution requires an active drive.' };

      return {
        userId,
        tenantId: drive.ownerId,
        driveId,
        conversationId,
        requestOrigin: context?.requestOrigin,
        agentPageId: context?.chatSource?.agentPageId ?? context?.parentAgentId,
        actorEmail: actorInfo.actorEmail,
        actorDisplayName: actorInfo.actorDisplayName,
        aiProvider: context?.aiProvider,
        aiModel: context?.aiModel,
        tier: toTier(actorRow?.subscriptionTier),
      };
    }

    // Global AI without a drive: user is their own isolation boundary.
    // tenantId = userId keeps the session key and quota scopes user-owned.
    // Side-effect: the tenant quota bucket becomes code-exec:tenant:<userId>,
    // a second user-keyed window alongside code-exec:user:<userId>. This
    // over-counts conservatively (only tightens budget) and is acceptable while
    // the feature is admin-gated. Revisit if tenant-scope quota semantics matter.
    const [actorRow, actorInfo] = await Promise.all([
      deps.findUser(userId),
      deps.getActorInfo(userId),
    ]);

    return {
      userId,
      tenantId: userId,
      conversationId,
      requestOrigin: context?.requestOrigin,
      agentPageId: context?.chatSource?.agentPageId ?? context?.parentAgentId,
      actorEmail: actorInfo.actorEmail,
      actorDisplayName: actorInfo.actorDisplayName,
      aiProvider: context?.aiProvider,
      aiModel: context?.aiModel,
      tier: toTier(actorRow?.subscriptionTier),
    };
  };
}

/**
 * Resolve the actor context from the chat tool context. The drive comes from the
 * active location; the tenant is the drive's owning account (the cloud tenant
 * boundary); the concurrency tier is the acting user's subscription tier.
 *
 * Global assistant context (chatSource.type === 'global') is a first-class path:
 * driveId may be absent and resolves with tenantId = userId.
 * Page AI (chatSource.type === 'page' or undefined) requires driveId — fail closed.
 */
export const resolveSandboxActorContext: ResolveSandboxContext =
  createResolveSandboxActorContext();

/**
 * IO dependencies for the machine directory. Injected so it can be unit-tested
 * without a real database connection.
 */
export interface MachineDirectoryRuntimeDeps {
  findPage: (pageId: string) => Promise<{ title: string; type: string; driveId: string } | undefined>;
  canViewPage: (rawContext: ToolExecutionContext, pageId: string) => Promise<boolean>;
  /** `PageAgentConfig.terminalAccess`/`machines` — the canonical config source. */
  getAgentConfig: (agentPageId: string) => Promise<{ terminalAccess: boolean; machines: MachineRef[] } | null>;
  /** The global assistant's user-level parallel of `getAgentConfig` (globalAssistantConfig). */
  getGlobalConfig: (userId: string) => Promise<{ terminalAccess: boolean; machines: MachineRef[] }>;
  /** Lazily provision (or reuse) the personal Terminal page backing a user's global "own" machine. */
  getOrCreateOwnMachinePageId: (userId: string) => Promise<string>;
}

const defaultMachineDirectoryDeps: MachineDirectoryRuntimeDeps = {
  findPage: async (pageId) =>
    db.query.pages.findFirst({ where: eq(pages.id, pageId), columns: { title: true, type: true, driveId: true } }),
  canViewPage: canActorViewPage,
  getAgentConfig: (agentPageId) => pageAgentRepository.getAgentById(agentPageId),
  getGlobalConfig: (userId) => globalTerminalConfigRepository.getConfig(userId),
  getOrCreateOwnMachinePageId: (userId) => globalTerminalConfigRepository.getOrCreateOwnMachinePageId(userId),
};

/**
 * Resolves the global assistant's configured machine list: gated by the
 * user's own `terminalAccess` (default off → no machines), same as a page
 * agent. Its 'own' machine has no agent page to serve as its identity
 * (machine-session.ts's resolveMachinePageId doc comment), so it is resolved
 * transparently here into the user's lazily-provisioned personal Terminal
 * page — everything downstream (routing, permissions, activity) then treats
 * it exactly like any other 'existing' machine.
 */
async function resolveGlobalConfiguredMachines(
  userId: string,
  deps: MachineDirectoryRuntimeDeps,
): Promise<MachineRef[]> {
  const config = await deps.getGlobalConfig(userId);
  if (!config.terminalAccess) return [];
  const configured = config.machines.length > 0 ? config.machines : [{ kind: 'own' as const }];
  return Promise.all(
    configured.map(async (m) =>
      m.kind === 'own'
        ? { kind: 'existing' as const, terminalId: await deps.getOrCreateOwnMachinePageId(userId) }
        : m,
    ),
  );
}

/**
 * Resolves an agent's configured machine list for `listMachines`. A page
 * agent's list is gated by `terminalAccess` (default off → no machines);
 * `machines[0]` is the default active machine, falling back to 'own' if
 * `terminalAccess` is on but no machine has been configured yet. No
 * `agentPageId` means the global assistant — see resolveGlobalConfiguredMachines.
 */
async function resolveConfiguredMachines(
  agentPageId: string | undefined,
  userId: string | undefined,
  deps: MachineDirectoryRuntimeDeps,
): Promise<MachineRef[]> {
  if (agentPageId) {
    const agent = await deps.getAgentConfig(agentPageId);
    if (!agent?.terminalAccess) return [];
    return agent.machines.length > 0 ? agent.machines : [{ kind: 'own' }];
  }
  if (!userId) return [];
  return resolveGlobalConfiguredMachines(userId, deps);
}

function activeMachineAgentPageId(rawContext: ToolExecutionContext | undefined): string | undefined {
  return rawContext?.chatSource?.agentPageId ?? rawContext?.parentAgentId;
}

/**
 * Factory for the machine directory, with injected deps for testing. The
 * default export (`machineDirectory`) wires the real DB.
 */
export function createMachineDirectory(
  deps: MachineDirectoryRuntimeDeps = defaultMachineDirectoryDeps,
): MachineDirectoryDeps {
  return {
    listMachines: (rawContext) =>
      resolveConfiguredMachines(activeMachineAgentPageId(rawContext), rawContext?.userId, deps),
    describeMachine: async (_rawContext, machine) => {
      if (machine.kind === 'own') return { name: 'My Machine' };
      const page = await deps.findPage(machine.terminalId);
      return { name: page?.title ?? 'Terminal' };
    },
    isMachineAccessible: async (rawContext, machine) => {
      if (machine.kind === 'own') return true;
      if (!rawContext) return false;
      const page = await deps.findPage(machine.terminalId);
      if (!page || !isTerminalPage(page.type as PageType)) return false;
      return deps.canViewPage(rawContext, machine.terminalId);
    },
    resolveDriveId: async (_rawContext, machine, ambientDriveId) => {
      if (machine.kind === 'own') return ambientDriveId;
      const page = await deps.findPage(machine.terminalId);
      return page?.driveId ?? ambientDriveId;
    },
  };
}

export const machineDirectory: MachineDirectoryDeps = createMachineDirectory();

/**
 * Production sandbox tools, fully wired. Exported for PR4 to register behind the
 * default-OFF feature flag — importing this object does not expose anything by
 * itself.
 */
export function buildSandboxTools(): {
  bash: Tool;
  writeFile: Tool;
  readFile: Tool;
  editFile: Tool;
  switch_machine: Tool;
  list_machines: Tool;
} {
  return createSandboxTools({
    runDeps: buildRealSandboxRunDeps(),
    resolveContext: resolveSandboxActorContext,
    gate: (ctx) =>
      gateSandboxToolCall({
        userId: ctx.userId,
        driveId: ctx.driveId,
        tenantId: ctx.tenantId,
        requestOrigin: ctx.requestOrigin,
        agentPageId: ctx.agentPageId,
        tier: ctx.tier,
      }),
    machines: machineDirectory,
  });
}
