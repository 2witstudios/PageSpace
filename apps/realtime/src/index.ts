import './instrument';
import * as Sentry from '@sentry/node';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Server, Socket } from 'socket.io';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { verifyBroadcastSignature } from '@pagespace/lib/auth/broadcast-auth';
import * as dotenv from 'dotenv';
import { db } from '@pagespace/db/db';
import { eq, and, or } from '@pagespace/db/operators';
import { dmConversations } from '@pagespace/db/schema/social';
import { users } from '@pagespace/db/schema/auth';
import { userProfiles } from '@pagespace/db/schema/members';
import { pages, drives } from '@pagespace/db/schema/core';
import { canRunCode, isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import {
  decideFullEgressEnablement,
  isContainmentVerified,
} from '@pagespace/lib/services/sandbox/containment';
import {
  getSandboxSessionSecret,
  acquireMachineSession,
  createDbMachineSessionStore,
  deriveMachineSessionKey,
  findLiveMachineSandboxId,
} from '@pagespace/lib/services/sandbox/machine-session-manager';
import { defaultSandboxBillingDeps } from '@pagespace/lib/services/sandbox/machine-billing';
import { measureMachineStorageOpportunistically } from '@pagespace/lib/services/sandbox/machine-storage-billing';
import { checkMachineRuntimeGuardrail, recordMachineActivity, acquireCodeExecutionSlot, releaseCodeExecutionSlot } from '@pagespace/lib/services/sandbox/quota';
import { createSpritesSandboxClient, createSpriteHandleCache, type SpritesSdk } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { createSpriteMachineHost } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-machine-host';
import {
  createSpriteTasksClient,
  createTaskHoldController,
  taskHoldName,
  resolveTaskHoldConfig,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprite-tasks';
import { createExecClientFromMachineHost } from '@pagespace/lib/services/sandbox/sandbox-client/machine-host-adapter';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import {
  buildAgentTerminalHandlers,
  ensureAgentTerminalSession,
  armIdleReap,
  type AgentTerminalSessionDeps,
  type SocketLike,
} from './terminal/agent-terminal-handler';
import { handleTerminalActivityRequest } from './terminal/terminal-activity';
import { handleSessionReadRequest, handleSessionSendRequest } from './terminal/session-io';
import { deriveAgentTerminalSessionKey, agentTerminalScopeFromNames } from './terminal/agent-terminal-session-key';
import { buildAgentTerminalCheckAuth, resolveMachineSandbox } from './terminal/agent-terminal-access';
import { createTerminalSessionMap, type TerminalSession } from './terminal/terminal-session-map';
import { openPtyShell } from './terminal/sprites-shell';
import { getRealtimeSpritesSdk } from './terminal/realtime-sprites-client';
import { createDbMachineBranchStore } from '@pagespace/lib/services/machines/machine-branches-store';
import { propagateClaudeCredential } from '@pagespace/lib/services/machines/machine-branches';
import { createDbMachineAgentTerminalStore } from '@pagespace/lib/services/machines/agent-terminals-store';
import { createDbMachineProjectStore } from '@pagespace/lib/services/machines/machine-projects-store';
import {
  resolveAgentTerminal,
  resolveAgentTerminalRow,
  type AgentTerminalMachineSandbox,
  type AgentTerminalMachineSandboxResult,
} from '@pagespace/lib/services/machines/agent-terminals';
import {
  validatePageId,
  validateDriveId,
  validateConversationId,
  validatePresencePagePayload,
  emitValidationError,
} from './validation';
import { loggers, initializeLogging } from '@pagespace/lib/logging/logger-config';
import { decryptField } from '@pagespace/lib/encryption/field-crypto';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { socketRegistry } from './socket-registry';
import { handleKickRequest } from './kick-handler';
import { authorizeBroadcastAudience } from './broadcast-audience';
import { presenceTracker, type PresenceViewer } from './presence-tracker';
import { withPerEventAuth, type AuthSocket } from './per-event-auth';

dotenv.config({ path: '../../.env' });

// realtime's first-ever global crash visibility: an uncaught exception or
// unhandled rejection used to just kill the process with no record anywhere.
initializeLogging(async (error) => {
  Sentry.captureException(error);
  await Sentry.flush(2000);
});

// One map for every agent terminal (Terminal — universal scope reshape): a
// Sprite (the owning Machine's own persistent one, for machine/project scope,
// or a branch's isolated one) can host several of these concurrently, each
// keyed by its own (scope, name) sessionKey — this REPLACES the retired
// human-only `terminal:*` family (a plain shell is now a machine-scope agent
// terminal of `agentType: 'shell'` on this same map).
const agentTerminalSessionMap = createTerminalSessionMap();

// Cache the DB terminal session store promise at module level (created once, not per-connection).
const dbMachineSessionStorePromise = createDbMachineSessionStore();
const dbMachineBranchStorePromise = createDbMachineBranchStore();
const dbMachineAgentTerminalStorePromise = createDbMachineAgentTerminalStore();
const dbMachineProjectStorePromise = createDbMachineProjectStore();

/** The conventional name for a machine's plain shell — a machine-scope agent terminal of `agentType: 'shell'` (see `agent-terminal-types.ts`), the retired human `terminal:*` family's replacement. */
const SHELL_AGENT_TERMINAL_NAME = 'shell';

/**
 * Decrypt PII at the edge (GDPR #965): actorEmail is denormalized into a
 * plaintext activity-log/audit snapshot downstream (writeCodeExecutionAudit),
 * not an encrypted column, so a ciphertext users.email must never reach it.
 * Extracted as a pure helper (rather than inlined in makeAgentTerminalCheckAuth)
 * so it's directly unit-testable without mocking the rest of the terminal-auth
 * pipeline (sandbox provisioning, sprites SDK, audit sink).
 */
export async function resolveActorEmail(rawEmail: string | null | undefined): Promise<string> {
  return rawEmail ? await decryptField(rawEmail) : '';
}

/**
 * A page's CURRENT driveId + that drive's owner (the `tenantId` convention
 * `deriveMachineSessionKey` uses) — the two reads `buildMachineSandbox.acquire`
 * already did inline, now shared with `refreshBranchCredential` below so a
 * bare-`pageId` lookup is never substituted for deriving the exact CURRENT
 * session key (a page moved between drives can leave its OLD drive's session
 * row behind under a DIFFERENT key — see `findLiveMachineSandboxId`'s doc
 * comment on `machine-session-manager.ts`).
 */
type DriveOwnerContextResult =
  | { ok: true; driveId: string; tenantId: string }
  | { ok: false; reason: 'page_not_found' | 'drive_not_found' };

async function resolveDriveOwnerContext(pageId: string): Promise<DriveOwnerContextResult> {
  const [pageRow] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!pageRow) return { ok: false, reason: 'page_not_found' };
  const [driveRow] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, pageRow.driveId)).limit(1);
  if (!driveRow) return { ok: false, reason: 'drive_not_found' };
  return { ok: true, driveId: pageRow.driveId, tenantId: driveRow.ownerId };
}

/**
 * Acquires the OWNING Machine's persistent Sprite for `AgentTerminalMachineSandbox`
 * (machine/project scope share this one Sprite — see `agent-terminals.ts`),
 * re-authorizing `actorUserId` (resume re-authz) on every call. Mirrors the
 * acquisition the retired human terminal's `makeTerminalCheckAuth` used to
 * perform inline.
 *
 * Does NOT wake the Sprite, and does not read it a second time to try. A Sprite
 * has no explicit wake API — an incoming request wakes it automatically
 * (docs.sprites.dev/concepts/lifecycle) — so the PTY's own `createSession` /
 * `attachSession` IS the wake, and it already carries the bounded pre-open retry
 * that the cold-start drop needs (`withWakeRetry` / `openPtyShell`'s reconnect).
 * The `sh -c :` this used to run first bought nothing but a SECOND cold start on
 * the slowest path we have.
 *
 * `sdk` is threaded in (rather than resolved here) so the whole connect —
 * acquire, auth, launch resolution — shares ONE `createSpriteHandleCache` and
 * therefore ONE underlying `getSprite`.
 */
function buildMachineSandbox(actorUserId: string, sdk: SpritesSdk): AgentTerminalMachineSandbox {
  // The caller (resolveProjectOrMachineLocation, agent-terminals.ts) collapses
  // every acquire failure to one generic 'machine_unavailable' reason — log the
  // SPECIFIC reason here so it's still visible in realtime logs for triage.
  function deny(reason: string, machineId: string): AgentTerminalMachineSandboxResult {
    loggers.realtime.warn('Machine sandbox acquire denied', { reason, machineId, actorUserId });
    return { ok: false, reason };
  }

  return {
    acquire: async (machineId): Promise<AgentTerminalMachineSandboxResult> => {
      const context = await resolveDriveOwnerContext(machineId);
      if (!context.ok) return deny(context.reason, machineId);
      const { driveId, tenantId } = context;

      const nowMs = Date.now();
      const guardrail = checkMachineRuntimeGuardrail({ machineKey: machineId, now: nowMs });
      if (!guardrail.allowed) return deny(guardrail.reason, machineId);

      const store = await dbMachineSessionStorePromise;
      const rawClient = createSpritesSandboxClient({ sdk });
      const host = createSpriteMachineHost({ sdk, client: rawClient });
      const client = createExecClientFromMachineHost(host, { kind: 'sprite' });

      const result = await acquireMachineSession({
        pageId: machineId,
        driveId,
        tenantId,
        userId: actorUserId,
        // Already authorized by the caller's access + canRunCode checks before
        // resolveAgentTerminal ever reaches this acquire.
        canRun: true,
        deps: {
          store,
          client,
          now: () => new Date(),
          secret: getSandboxSessionSecret(),
          checkFullEgressEnablement: async () =>
            decideFullEgressEnablement({
              adminGateEnabled: isCodeExecutionEnabled(),
              containment: isContainmentVerified() ? { contained: true } : null,
            }),
        },
      });
      if (!result.ok) return deny(result.reason, machineId);

      recordMachineActivity({ machineKey: machineId, now: nowMs });

      // Opportunistic storage measurement (Sprites 6-1): this is the
      // terminal-CONNECT wake — the reconcile relies on it to meter machines
      // used only through the interactive PTY (no agent tool ops), which would
      // otherwise stay never-measured and bill the 0 floor forever. Throttled +
      // best-effort; the network `attach` is lazy, paid only when a measurement
      // is actually due, and this never blocks or fails the PTY session.
      void measureMachineStorageOpportunistically({
        pageId: machineId,
        resolveHandle: () => host.attach({ machineId: result.sandboxId }),
      });

      return { ok: true, sandboxId: result.sandboxId };
    },
  };
}

/**
 * Shell adapter over the pure `deriveAgentTerminalSessionKey`
 * (`agent-terminal-session-key.ts`): maps the transport's optional
 * (projectName, branchName) pair into the discriminated scope and keys off the
 * owning Machine Terminal page id (`machineId`), NOT the Sprite `sandboxId`.
 * Keying on `machineId` means a warm reattach never has to resolve the Sprite
 * before the fast-path map lookup can run.
 */
function buildAgentTerminalSessionKey({
  machineId,
  projectName,
  branchName,
  name,
}: {
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
}): string {
  return deriveAgentTerminalSessionKey({
    machineId,
    scope: agentTerminalScopeFromNames({ projectName, branchName }),
    name,
  });
}

/**
 * Resolve the Sprite a FRESH agent-terminal PTY will attach to (lazy sprite
 * resolution — leaf 1-2): resolve the (scope, name) target down to its Machine
 * Sprite via `resolveAgentTerminal` (machine/project scope may reconnect/resume
 * the Sprite through `buildMachineSandbox`), then read that Sprite. Deliberately
 * NOT part of the access decision — a Sprite is woken automatically by any exec,
 * so authorization never needs to touch it (see `agent-terminal-access.ts`).
 *
 * ONE `createSpriteHandleCache` is built here, per connect, and threaded through
 * BOTH halves — the machine acquire (whose `getOrCreate` probes the Sprite by
 * name) and the launch resolution below (which needs the raw handle for the PTY).
 * They read the same Sprite, so they now share one control-plane round-trip
 * instead of paying for two. The cache is deliberately connect-scoped, never
 * module-scoped: a Sprite handle is a live object, and a process-lifetime cache
 * would keep serving one that has since been destroyed and re-created under the
 * same name.
 */
async function resolveAgentTerminalSandbox({
  userId,
  machineId,
  projectName,
  branchName,
  name,
}: {
  userId: string;
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
}) {
  const sdk = createSpriteHandleCache(await getRealtimeSpritesSdk());
  // Construction only (no I/O) — cheap to build unconditionally even for
  // machine/project-scope targets that never touch `refreshBranchCredential`.
  const host = createSpriteMachineHost({ sdk, client: createSpritesSandboxClient({ sdk }) });

  return resolveMachineSandbox(
    { machineId, projectName, branchName, name },
    {
      resolveAgentTerminal: async (target) => {
        const [branchStore, agentTerminalStore, projectStore] = await Promise.all([
          dbMachineBranchStorePromise,
          dbMachineAgentTerminalStorePromise,
          dbMachineProjectStorePromise,
        ]);
        return resolveAgentTerminal({
          machineId: target.machineId,
          projectName: target.projectName,
          branchName: target.branchName,
          name: target.name,
          deps: {
            branchStore,
            store: agentTerminalStore,
            projectStore: { findByName: (tId, pName) => projectStore.findByName(tId, pName) },
            machineSandbox: buildMachineSandbox(userId, sdk),
          },
        });
      },
      // Served from the cache the acquire above already populated (machine/project
      // scope). A branch-scope target never acquires, so this is its one and only
      // read.
      getSprite: (sandboxId) => sdk.getSprite(sandboxId),
      // Refresh the branch Sprite's Claude Code credential from the root
      // Machine's own Sprite (see `propagateClaudeCredential`'s doc comment on
      // `machine-branches.ts`) — this IS the branch's actual attach path for
      // opening/reattaching its agent terminal, unlike `spawnBranch`/
      // `attachBranch`, which this bridge never calls. `resolveMachineSandbox`
      // only invokes this for branch-scope targets. Shares this connect's
      // handle cache (`sdk`), so re-reading the ALREADY-fetched branch Sprite
      // costs nothing; only the root Sprite's read is a genuinely new call.
      refreshBranchCredential: async ({ machineId: rootMachineId, sandboxId }) => {
        try {
          const branchHandle = await host.attach({ machineId: sandboxId });
          if (!branchHandle) return;
          await propagateClaudeCredential({
            machineId: rootMachineId,
            branchHandle,
            resolveRootMachineHandle: async (mid) => {
              // Derives the CURRENT session key (driveId + drive owner), not
              // a bare-pageId lookup — see `findLiveMachineSandboxId`'s doc
              // comment on why that would risk resolving a STALE session
              // left behind by a prior drive move (caught in review, P1).
              const context = await resolveDriveOwnerContext(mid);
              if (!context.ok) return null;
              const rootSandboxId = await findLiveMachineSandboxId({
                tenantId: context.tenantId,
                driveId: context.driveId,
                pageId: mid,
                secret: getSandboxSessionSecret(),
              });
              if (!rootSandboxId) return null;
              return host.attach({ machineId: rootSandboxId });
            },
          });
        } catch {
          // Best-effort — a credential refresh must never block or fail
          // opening the PTY itself (see `ResolveMachineSandboxDeps.
          // refreshBranchCredential`'s doc comment).
        }
      },
    },
  );
}

/**
 * Auth for a named, pluggable-agent-typed terminal at one of the three
 * universal Terminal scopes (`agent-terminals.ts`) — access is governed by
 * the OWNING Machine's Terminal page (`machineId`), same edit-level bar the
 * retired human terminal used, then resolved down to the specific
 * machine/project/branch target + agent-terminal row. Does not provision an
 * agent-terminal row itself: an unreserved (scope, name) is `not_found`
 * (spawn it first via the Runtime API), and a vanished Sprite fails at the
 * `getSprite` step. The pure access decision (`decideAgentTerminalAccess`) and
 * the lazy sprite resolution (`resolveAgentTerminalSandbox`) are split (leaf
 * 1-2) so the re-auth interval can re-check access alone — this composition
 * just wires the real IO dependencies into both halves.
 */
const makeAgentTerminalCheckAuth = buildAgentTerminalCheckAuth({
  getAccessLevel: (userId, machineId) => getUserAccessLevel(userId, machineId),
  getPageDriveId: async (machineId) => {
    const [pageRow] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, machineId)).limit(1);
    return pageRow;
  },
  canRunCode: ({ userId, driveId, requestOrigin }) => canRunCode({ userId, driveId, requestOrigin }),
  getDriveAndUser: async ({ driveId, userId }) => {
    const [driveRow, userRow] = await Promise.all([
      db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId)).limit(1).then((r) => r[0]),
      db.select({ subscriptionTier: users.subscriptionTier, email: users.email }).from(users).where(eq(users.id, userId)).limit(1).then((r) => r[0]),
    ]);
    return { driveRow, userRow };
  },
  resolveActorEmail,
  acquireSlot: ({ userId, tier }) => acquireCodeExecutionSlot({ userId, tier }),
  releaseSlot: (userId) => releaseCodeExecutionSlot({ userId }),
  resolveSandbox: (target) => resolveAgentTerminalSandbox(target),
  // DB-only existence check for the (scope, name) target — no Sprite is resolved
  // or woken, so the reattach fast path and the 60s re-auth tick can both afford
  // to run it. It is what keeps a deleted project/branch/agent-terminal row from
  // going unnoticed now that the sandbox resolution is lazy.
  resolveMachineRow: async ({ machineId, projectName, branchName, name }) => {
    const [branchStore, agentTerminalStore, projectStore] = await Promise.all([
      dbMachineBranchStorePromise,
      dbMachineAgentTerminalStorePromise,
      dbMachineProjectStorePromise,
    ]);
    return resolveAgentTerminalRow({
      machineId,
      projectName,
      branchName,
      name,
      deps: {
        branchStore,
        store: agentTerminalStore,
        projectStore: { findByName: (tId, pName) => projectStore.findByName(tId, pName) },
      },
    });
  },
  // Write code execution audit record (agent terminal PTY session open) — this
  // launches an arbitrary pluggable agent binary (the resolved command, or a
  // per-terminal command override) inside the Sprite.
  writeAudit: ({ userId, actorEmail, driveId, command }) => {
    writeCodeExecutionAudit({
      input: {
        userId,
        actorEmail,
        driveId,
        requestOrigin: 'user',
        profile: 'pty',
        code: `[Agent terminal session opened: ${command}]`,
        exitCode: null,
        durationMs: 0,
        timestamp: new Date(),
      },
    }).catch(() => {});
  },
  buildSessionKey: ({ machineId, projectName, branchName, name }) =>
    buildAgentTerminalSessionKey({ machineId, projectName, branchName, name }),
  logDenied: (reason, context) => loggers.realtime.warn('Agent terminal auth denied', { reason, ...context }),
  logSandboxLookupFailed: (context) => loggers.realtime.warn('Agent terminal sandbox lookup failed', { reason: 'provision_failed', ...context }),
});

/**
 * Everything it takes to START a PTY, wired once for BOTH callers: a viewer's
 * `agent-terminal:connect` (below) and a headless start driven by agent IO over
 * signed HTTP (`startHeadlessAgentTerminal`). Shared deliberately — a second
 * copy of the billing seam or the task-hold factory is a second place for
 * slot accounting and metering to drift.
 */
const agentTerminalSessionDeps: AgentTerminalSessionDeps = {
  sessionMap: agentTerminalSessionMap,
  openShell: openPtyShell,
  checkAuth: makeAgentTerminalCheckAuth,
  persistStreamSessionId: async ({ agentTerminalId, sessionId }) => {
    const store = await dbMachineAgentTerminalStorePromise;
    await store.updateStreamSessionId({ id: agentTerminalId, streamSessionId: sessionId, now: new Date() });
  },
  // Issue #2205: bounded scrollback tail persisted once per teardown, so a
  // `read_session` after the PTY has died can still answer with its final
  // output instead of `live:false` and nothing. Shared by both callers — a
  // headless session's idle reap or exit deserves the same cold-read recovery
  // a viewer-created one gets.
  persistColdTail: async ({ agentTerminalId, tail, hasOutput, endedAt }) => {
    const store = await dbMachineAgentTerminalStorePromise;
    await store.recordColdTail({ id: agentTerminalId, tail, hasOutput, endedAt });
  },
  // Terminal Epic 3: meters this PTY session's active-runtime cost against the
  // machine's payer, whoever started it. Sprite wall-clock is equally billable
  // whether a human, a pluggable agent, or an agent's `send_session` woke it.
  billing: defaultSandboxBillingDeps,
  // Sprites Tasks API hold (leaf 5-1): while an agent is running or a
  // viewer attached, a short-expiry platform task (refreshed on a
  // heartbeat, deleted on exit) keeps the sprite from cold-pausing mid-run;
  // released when idle so the sprite CAN pause. 5m expiry / 60s refresh
  // defaults, overridable via SPRITE_TASK_HOLD_EXPIRE_SECONDS /
  // SPRITE_TASK_HOLD_REFRESH_MS.
  createTaskHold: ({ sprite, sessionKey }) =>
    createTaskHoldController({
      client: createSpriteTasksClient({ sprite }),
      // Per-INCARNATION name (session key + creation time), not per key: a
      // torn-down session's queued final DELETE runs on its own serialized
      // queue, so under a shared name it could land AFTER a quickly
      // reopened session's CREATE and destroy the live hold. Distinct names
      // make that race unrepresentable; an orphaned old task self-expires.
      taskName: taskHoldName(`${sessionKey}:${Date.now()}`),
      ...resolveTaskHoldConfig(process.env),
      onError: (stage, result) => {
        // Degrade gracefully: a lost hold means a possible pause, which the
        // checkpoint work (5-2) already survives — log and carry on.
        // exitCode 127 = curl missing from the sprite image (feature inert
        // for this sprite); an HTTP status = the tasks API answered.
        loggers.realtime.warn(`Sprite task hold ${stage} failed`, {
          sessionKey,
          status: result.status,
          exitCode: result.exitCode,
        });
      },
    }),
};

/**
 * The geometry a shell nobody is looking at is born with.
 *
 * A PTY must have one — programs read `$COLUMNS`/`$LINES` and wrap their output
 * to it — and 80x24 is the conventional default a terminal with no window to
 * measure gets. The first human to open the pane resizes it to their real
 * window (`agent-terminal:resize`), so this only ever governs the wrapping of
 * output produced before anyone looked.
 */
const HEADLESS_COLS = 80;
const HEADLESS_ROWS = 24;

/**
 * Start a PTY for an agent that is reading or typing into a shell whose session
 * has never run (issue #2206) — the `startSession` seam of `session-io.ts`.
 *
 * Authorization is decided HERE, against the userId the (signed) request names,
 * and not inherited from the web tier's own check. The web tier authorized a
 * conversation's access to a session ADDRESS; this starts a sandbox process —
 * reserving that user's concurrency slot, billing their machine's payer, and
 * writing a code-execution audit row. Those are the socket path's reasons for
 * running `checkAuth` before `resolveSandbox`, and they do not become someone
 * else's job because the request arrived over HTTP.
 *
 * `undefined` for every failure: the caller's answer ("no PTY, nothing typed")
 * is the same whichever way a start failed, and the specific reason is already
 * logged by `checkAuth`/`resolveSandbox` at the point it was decided.
 *
 * `abandoned` DOES have a real signal here, unlike a socket connect (which has
 * no equivalent — see the old comment this replaced): the web tier's `fetch`
 * to this endpoint gives up after `REALTIME_TIMEOUT_MS` (5s, `session-io-pty.ts`),
 * and a cold start — `resolveSandbox` waking a Sprite, then a liveness check —
 * can run past that. Forwarded straight to `ensureAgentTerminalSession`'s own
 * check at the last await before the PTY exists, keyed off the SAME request's
 * connection rather than a viewer's `connectionId`.
 */
const startHeadlessAgentTerminal = async (
  {
    machineId,
    projectName,
    branchName,
    name,
    userId,
  }: {
    machineId: string;
    projectName?: string;
    branchName?: string;
    name: string;
    userId: string;
  },
  abandoned: () => boolean,
) => {
  const access = await makeAgentTerminalCheckAuth({ userId, machineId, projectName, branchName, name });
  if (!access.ok) return undefined;

  const outcome = await ensureAgentTerminalSession(agentTerminalSessionDeps, {
    access,
    target: { machineId, projectName, branchName, name },
    userId,
    cols: HEADLESS_COLS,
    rows: HEADLESS_ROWS,
    abandoned,
  });
  if (outcome.kind === 'failed') return undefined;
  loggers.realtime.info('Agent terminal session started headlessly', {
    sessionKey: access.sessionKey,
    sandboxId: outcome.session.sandboxId,
    reused: outcome.kind === 'existing',
  });
  return outcome.session;
};

/** The session-IO deps both HTTP verbs share — the map, the key derivation, and the two effects. */
const sessionIoDeps = {
  sessionMap: agentTerminalSessionMap,
  sessionKeyFor: buildAgentTerminalSessionKey,
  startSession: startHeadlessAgentTerminal,
  // `agentTerminalSessionDeps` already carries `billing` and `persistColdTail`
  // — the same two teardown-time effects a socket-created session's reap
  // uses, so a headless session's reap persists its cold tail too.
  rearmIdleReap: (session: TerminalSession) =>
    armIdleReap(agentTerminalSessionDeps, agentTerminalSessionMap, session),
};

/**
 * Origin Validation for WebSocket Connections (Defense-in-Depth with Blocking)
 *
 * This module provides explicit origin validation that BLOCKS invalid origins.
 * Socket.IO CORS is a first line of defense, but this provides defense-in-depth
 * by rejecting connections from unexpected origins at the middleware level.
 */

/**
 * Normalizes an origin URL by extracting protocol, host, and port
 * This ensures consistent comparison between origins
 *
 * @param origin - The origin URL to normalize
 * @returns Normalized origin (protocol://host:port) or empty string if invalid
 */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Gets the list of allowed origins from environment configuration
 *
 * @returns Array of allowed origin URLs
 */
function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  // Primary origins from CORS_ORIGIN or WEB_APP_URL (matches Socket.IO CORS config)
  const corsOrigin = process.env.CORS_ORIGIN;
  const webAppUrl = process.env.WEB_APP_URL;

  if (corsOrigin) {
    const normalized = normalizeOrigin(corsOrigin);
    if (normalized) origins.push(normalized);
  } else if (webAppUrl) {
    const normalized = normalizeOrigin(webAppUrl);
    if (normalized) origins.push(normalized);
  }

  // Additional origins from ADDITIONAL_ALLOWED_ORIGINS (comma-separated)
  const additionalOrigins = process.env.ADDITIONAL_ALLOWED_ORIGINS;
  if (additionalOrigins) {
    const parsed = additionalOrigins
      .split(',')
      .map((o) => normalizeOrigin(o.trim()))
      .filter((o) => o.length > 0);
    origins.push(...parsed);
  }

  return origins;
}

/**
 * Checks if the given origin is in the allowed list
 *
 * @param origin - The origin to validate
 * @param allowedOrigins - List of allowed origins
 * @returns true if origin is allowed, false otherwise
 */
function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  return allowedOrigins.some((allowed) => allowed === normalizedOrigin);
}

/**
 * Result of WebSocket origin validation
 */
interface WebSocketOriginValidationResult {
  /** Whether the origin is valid (allowed or not required) */
  isValid: boolean;
  /** The origin that was validated (normalized), or undefined if not provided */
  origin: string | undefined;
  /** Reason for the validation result */
  reason: 'valid' | 'no_origin' | 'invalid' | 'no_config';
}

/**
 * Validates a WebSocket connection origin against allowed origins
 *
 * This helper function provides a simple boolean check for origin validation.
 * It can be used for additional security monitoring or optional blocking decisions.
 *
 * Validation rules:
 * - Missing origin: Returns valid (non-browser clients like curl, mobile apps)
 * - No config: Returns valid with warning (CORS_ORIGIN/WEB_APP_URL not set)
 * - Origin matches allowed list: Returns valid
 * - Origin doesn't match: Returns invalid
 *
 * @param origin - The Origin header value from the connection request
 * @returns Validation result with isValid boolean and reason
 *
 * @example
 * ```typescript
 * const result = validateWebSocketOrigin(socket.handshake.headers.origin);
 * if (!result.isValid) {
 *   // Optionally reject the connection or log a warning
 *   socket.disconnect();
 * }
 * ```
 */
/* c8 ignore start */
function validateWebSocketOrigin(origin: string | undefined): WebSocketOriginValidationResult {
  // No origin header - non-browser client, allow by default
  if (!origin) {
    return {
      isValid: true,
      origin: undefined,
      reason: 'no_origin',
    };
  }

  const normalizedOrigin = normalizeOrigin(origin);
  const allowedOrigins = getAllowedOrigins();

  // No allowed origins configured - allow but this is a misconfiguration
  if (allowedOrigins.length === 0) {
    return {
      isValid: true,
      origin: normalizedOrigin || origin,
      reason: 'no_config',
    };
  }

  // Check if origin is in allowed list
  if (isOriginAllowed(origin, allowedOrigins)) {
    return {
      isValid: true,
      origin: normalizedOrigin,
      reason: 'valid',
    };
  }

  // Origin not in allowed list
  return {
    isValid: false,
    origin: normalizedOrigin || origin,
    reason: 'invalid',
  };
}
/* c8 ignore stop */

/**
 * Validates WebSocket connection origin and returns whether to allow the connection
 *
 * This function BLOCKS connections from invalid origins (defense-in-depth).
 * Socket.IO CORS is a first line of defense, but this provides additional protection.
 *
 * @param origin - The Origin header value from the connection request
 * @param metadata - Additional metadata for logging (socketId, IP, etc.)
 * @returns true if connection should be allowed, false if it should be rejected
 */
function validateAndLogWebSocketOrigin(
  origin: string | undefined,
  metadata: { socketId: string; ip: string | undefined; userAgent: string | undefined }
): boolean {
  const allowedOrigins = getAllowedOrigins();

  // No origin header - non-browser client (curl, mobile apps, etc.)
  // Allow these as they authenticate via tokens, not cookies
  if (!origin) {
    loggers.realtime.debug('WebSocket origin validation: no Origin header', {
      ...metadata,
      reason: 'Non-browser client or same-origin request',
    });
    return true;
  }

  // No allowed origins configured in production is a misconfiguration
  // In development, allow but warn. In production, this should fail closed.
  if (allowedOrigins.length === 0) {
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) {
      loggers.realtime.error('WebSocket origin validation: REJECTED - no allowed origins configured in production', {
        ...metadata,
        origin,
        severity: 'security',
        reason: 'CORS_ORIGIN and WEB_APP_URL not set in production',
      });
      return false;
    }
    loggers.realtime.warn('WebSocket origin validation: no allowed origins configured (allowing in development)', {
      ...metadata,
      origin,
      reason: 'CORS_ORIGIN and WEB_APP_URL not set',
    });
    return true;
  }

  // Check if origin is allowed
  if (isOriginAllowed(origin, allowedOrigins)) {
    loggers.realtime.debug('WebSocket origin validation: valid origin', {
      ...metadata,
      origin,
    });
    return true;
  }

  // Origin not in allowed list - REJECT the connection
  loggers.realtime.warn('WebSocket origin validation: REJECTED - unexpected origin', {
    ...metadata,
    origin,
    allowedOrigins,
    severity: 'security',
    reason: 'Origin not in allowed list - connection rejected',
  });
  return false;
}

const requestListener = (req: IncomingMessage, res: ServerResponse) => {
    // Helper to verify signature (shared by broadcast and kick)
    const verifySignature = (signatureHeader: string | undefined, body: string): boolean => {
        if (!signatureHeader) {
            loggers.realtime.warn('Request missing signature header', {
                url: req.url,
                ip: req.socket.remoteAddress,
                userAgent: req.headers['user-agent']
            });
            return false;
        }

        if (!verifyBroadcastSignature(signatureHeader, body)) {
            loggers.realtime.error('Request signature verification failed', {
                url: req.url,
                ip: req.socket.remoteAddress,
                userAgent: req.headers['user-agent'],
                hasSignature: !!signatureHeader,
                bodyLength: body.length
            });
            return false;
        }

        return true;
    };

    /**
     * Accumulate an internal-endpoint body with a hard byte cap. All five
     * signed endpoints share it: the HMAC check can only run once the body has
     * been read in full, so without a cap an UNAUTHENTICATED caller could
     * stream an arbitrarily large body and hold memory until the signature is
     * finally rejected. Past the cap the connection is destroyed outright —
     * there is no legitimate over-cap caller (the largest real payload is a
     * broadcast message envelope, far under the limit).
     */
    const MAX_INTERNAL_BODY_BYTES = 1024 * 1024;
    const readCappedBody = (onBody: (body: string) => void): void => {
        let body = '';
        let bytes = 0;
        let over = false;
        req.on('data', chunk => {
            if (over) return;
            bytes += chunk.length;
            if (bytes > MAX_INTERNAL_BODY_BYTES) {
                over = true;
                req.destroy();
                return;
            }
            body += chunk.toString();
        });
        req.on('end', () => {
            if (!over) onBody(body);
        });
    };

    /**
     * Has the CLIENT gone away before this request got an answer?
     *
     * Only meaningful for the two headless session-IO endpoints: their
     * `start: true` path can run a cold Sprite wake past the web tier's own
     * `fetch` timeout (`REALTIME_TIMEOUT_MS`, `session-io-pty.ts`), and this is
     * how `ensureAgentTerminalSession`'s `abandoned()` check — the same one a
     * viewer's socket connect uses — learns to bail rather than start a PTY
     * (and write input into it) for a caller who already gave up and may retry.
     *
     * Listens on `res`, NOT `req`. `req` (`IncomingMessage`) fires `'close'`
     * once its own body finishes being READ — for an ordinary POST that is
     * moments after `readCappedBody`'s `'end'`, while the async handler is
     * still doing real work (`resolveSandbox`, a liveness check) and the
     * RESPONSE hasn't been written yet. Wiring this to `req` would flag every
     * normal request as abandoned and silently break headless start outright.
     * `res` (`ServerResponse`) `'close'` fires when the underlying CONNECTION
     * tears down — which happens on an ordinary request too, but only once
     * the response has actually been sent, which is exactly what
     * `!res.writableEnded` distinguishes: a request that finished cleanly
     * must not be mistaken for one the caller walked away from.
     */
    const trackRequestAbandonment = (): (() => boolean) => {
        let requestAbandoned = false;
        res.on('close', () => {
            if (!res.writableEnded) requestAbandoned = true;
        });
        return () => requestAbandoned;
    };

    if (req.method === 'POST' && req.url === '/api/broadcast') {
        readCappedBody(body => {
            try {
                const signatureHeader = req.headers['x-broadcast-signature'] as string;
                if (!verifySignature(signatureHeader, body)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Authentication failed' }));
                    return;
                }

                const parsed = JSON.parse(body);

                // #972 + CodeQL js/user-controlled-bypass: the emit is NOT gated on a
                // raw user-controlled truthiness check (`if (channelId && event &&
                // payload)`). The SOLE guard is the trusted, pure validator
                // authorizeBroadcastAudience, which enforces field presence/type AND
                // that channelId names a real room shape. A valid HMAC signature
                // proves the SENDER (web backend); this proves the AUDIENCE target is
                // legitimate, so a signed-but-malformed/forged request cannot fan a
                // payload out to an arbitrary or wildcard room (GDPR Art 5(1)(c) + 32).
                const audience = authorizeBroadcastAudience(parsed ?? {});
                if (!audience.allowed) {
                    // A disallowed room shape is an authorization failure (403); a
                    // missing/mistyped field is a malformed payload (400).
                    const isAudienceRejection =
                        audience.reason === 'channelId does not match an allowed room shape';
                    if (isAudienceRejection) {
                        loggers.realtime.warn('Broadcast audience not authorized', {
                            channelId: parsed?.channelId,
                            event: parsed?.event,
                            reason: audience.reason,
                            ip: req.socket.remoteAddress,
                        });
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Broadcast audience not authorized' }));
                    } else {
                        loggers.realtime.warn('Invalid broadcast payload structure', {
                            reason: audience.reason,
                        });
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid broadcast payload' }));
                    }
                    return;
                }

                const { channelId, event, payload } = parsed;
                io.to(channelId).emit(event, payload);
                loggers.realtime.debug('Broadcast event sent successfully', {
                    channelId,
                    event,
                    payloadKeys: Object.keys(payload)
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                loggers.realtime.error('Broadcast request processing error', error as Error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/api/terminal-activity') {
        // Streams an agent's bash run into a live Terminal's PTY/output feed
        // (Terminal Epic 1 T1.5, activity visibility). Best-effort: a live
        // session may not exist (nobody watching), which is not an error.
        readCappedBody(body => {
            const signatureHeader = req.headers['x-broadcast-signature'] as string;
            if (!verifySignature(signatureHeader, body)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Authentication failed' }));
                return;
            }

            handleTerminalActivityRequest(
                {
                    sessionMap: agentTerminalSessionMap,
                    // The machine's conventional 'shell' agent terminal (the retired
                    // human `terminal:*` family's replacement) is keyed on the owning
                    // Terminal page id (`pageId` == the checkAuth `machineId`), so its
                    // in-memory sessionKey is derivable WITHOUT resolving the Sprite. We
                    // still gate on the persisted machine_sessions record existing (no
                    // provisioning) so we only target a shell that has actually run.
                    resolveSessionKey: async ({ tenantId, driveId, pageId }) => {
                        const store = await dbMachineSessionStorePromise;
                        const key = deriveMachineSessionKey({ tenantId, driveId, pageId, secret: getSandboxSessionSecret() });
                        const record = await store.findBySessionKey(key);
                        return record ? buildAgentTerminalSessionKey({ machineId: pageId, name: SHELL_AGENT_TERMINAL_NAME }) : null;
                    },
                },
                body,
            ).then((result) => {
                res.writeHead(result.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result.body));
            }).catch((error: unknown) => {
                loggers.realtime.error('Terminal activity request failed', error instanceof Error ? error : new Error(String(error)));
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Internal error' }));
            });
        });
    } else if (req.method === 'POST' && req.url === '/api/session-read') {
        // read_session (PTY half) + the list_sessions liveness sweep. The bytes
        // live in THIS process's session map, so the web tier — which has
        // already resolved and authorized the session against the
        // conversation's derived handle set — asks for them over a signed POST.
        readCappedBody(body => {
            const signatureHeader = req.headers['x-broadcast-signature'] as string;
            if (!verifySignature(signatureHeader, body)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Authentication failed' }));
                return;
            }

            handleSessionReadRequest(sessionIoDeps, body, trackRequestAbandonment()).then((result) => {
                res.writeHead(result.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result.body));
            }).catch((error: unknown) => {
                loggers.realtime.error('Session read request failed', error instanceof Error ? error : new Error(String(error)));
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Internal error' }));
            });
        });
    } else if (req.method === 'POST' && req.url === '/api/session-input') {
        // send_session (PTY half): types stdin into a live agent-terminal PTY
        // through the same `session.command.write` a human viewer's keystroke
        // takes, so anyone watching sees it echoed exactly as they would see a
        // teammate type. Authorization happened in the web tier before signing.
        readCappedBody(body => {
            const signatureHeader = req.headers['x-broadcast-signature'] as string;
            if (!verifySignature(signatureHeader, body)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Authentication failed' }));
                return;
            }

            handleSessionSendRequest(sessionIoDeps, body, undefined, trackRequestAbandonment()).then((result) => {
                res.writeHead(result.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result.body));
            }).catch((error: unknown) => {
                loggers.realtime.error('Session input request failed', error instanceof Error ? error : new Error(String(error)));
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Internal error' }));
            });
        });
    } else if (req.method === 'POST' && req.url === '/api/kick') {
        // Kick API: Remove user from rooms on permission revocation
        readCappedBody(body => {
            const signatureHeader = req.headers['x-broadcast-signature'] as string;
            if (!verifySignature(signatureHeader, body)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Authentication failed' }));
                return;
            }

            const result = handleKickRequest(io, body);
            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.body));
        });
    } else {
        res.writeHead(404);
        res.end();
    }
};

const httpServer = createServer(requestListener);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = getAllowedOrigins();
      if (allowed.length === 0 || allowed.includes(normalizeOrigin(origin))) {
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed'));
      }
    },
    credentials: true,
  },
});

// AuthSocket is imported from per-event-auth.ts

/**
 * Look up user display metadata (name, avatar) and store on socket.data.
 * Called once per connection to avoid repeated DB queries during presence joins.
 */
async function populateUserMetadata(socket: AuthSocket): Promise<void> {
  const userId = socket.data.user?.id;
  if (!userId) return;

  try {
    const [userResult, profileResult] = await Promise.all([
      db.select({ name: users.name, image: users.image }).from(users).where(eq(users.id, userId)).limit(1),
      db.select({ displayName: userProfiles.displayName, avatarUrl: userProfiles.avatarUrl }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1),
    ]);

    // Decrypt PII at the edge (GDPR #965): users.name may be ciphertext;
    // userProfiles.displayName is never encrypted and takes precedence anyway,
    // so only decrypt when it's actually needed — a decrypt failure on a
    // stale/corrupt users.name must not discard an otherwise-valid displayName.
    const rawName = userResult[0]?.name;
    const displayName = profileResult[0]?.displayName;
    const decryptedName = !displayName && rawName ? await decryptField(rawName) : undefined;
    const name = displayName || decryptedName || 'Unknown';
    const avatarUrl = profileResult[0]?.avatarUrl || userResult[0]?.image || null;

    socket.data.user = { id: userId, name, avatarUrl };
  } catch (error) {
    loggers.realtime.error('Error populating user metadata', error as Error, { userId });
    // Keep the basic user data (just id) - presence will work with fallback name
    socket.data.user = { id: userId, name: 'Unknown', avatarUrl: null };
  }
}

io.use(async (socket: AuthSocket, next) => {
  // Extract connection metadata for logging
  const connectionMetadata = {
    socketId: socket.id,
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent']?.substring(0, 100),
  };

  // Validate Origin header - REJECT invalid origins (defense-in-depth)
  const origin = socket.handshake.headers.origin;
  const isOriginValid = validateAndLogWebSocketOrigin(origin, connectionMetadata);
  if (!isOriginValid) {
    return next(new Error('Origin not allowed'));
  }

  // Debug: Log all available authentication sources
  loggers.realtime.debug('Socket.IO: Authentication attempt', {
    authField: !!socket.handshake.auth.token,
    authTokenLength: socket.handshake.auth.token?.length || 0,
    hasCookieHeader: !!socket.handshake.headers.cookie,
    cookieHeader: socket.handshake.headers.cookie ? 'present' : 'missing',
    origin: origin,
    userAgent: socket.handshake.headers['user-agent']?.substring(0, 50)
  });

  // Get token from auth field (socket token from /api/auth/socket-token or session token from desktop app)
  const token = socket.handshake.auth.token;

  if (!token) {
    loggers.realtime.warn('Socket.IO: No token found in auth field', {
      authFieldEmpty: !socket.handshake.auth.token,
    });
    return next(new Error('Authentication error: No token provided.'));
  }

  // Check for socket token (ps_sock_*) first - these bypass sameSite: 'strict' cookies.
  // Socket tokens are unified opaque sessions (type: 'socket', #1054) validated the
  // same way as the ps_sess_* branch below.
  if (token.startsWith('ps_sock_')) {
    try {
      const sessionClaims = await sessionService.validateSession(token, { expectedType: 'socket' });
      if (!sessionClaims) {
        loggers.realtime.warn('Socket.IO: Socket token validation failed', { tokenPrefix: token.substring(0, 12) });
        return next(new Error('Authentication error: Invalid or expired socket token.'));
      }

      socket.data.user = { id: sessionClaims.userId, name: 'Unknown', avatarUrl: null };
      await populateUserMetadata(socket);
      loggers.realtime.info('Socket.IO: User authenticated via socket token', { userId: sessionClaims.userId });
      return next();
    } catch (error) {
      loggers.realtime.error('Error validating socket token', error as Error);
      return next(new Error('Authentication error: Server failed.'));
    }
  }

  // Check for session token (ps_sess_*) - used by mobile/desktop clients
  if (token.startsWith('ps_sess_')) {
    try {
      const sessionClaims = await sessionService.validateSession(token, { expectedType: 'user' });
      if (!sessionClaims) {
        loggers.realtime.warn('Socket.IO: Session token validation failed');
        return next(new Error('Authentication error: Invalid or expired session.'));
      }

      socket.data.user = { id: sessionClaims.userId, name: 'Unknown', avatarUrl: null };
      await populateUserMetadata(socket);
      loggers.realtime.info('Socket.IO: User authenticated via session token', { userId: sessionClaims.userId });
      return next();
    } catch (error) {
      loggers.realtime.error('Error validating session token', error as Error);
      return next(new Error('Authentication error: Server failed.'));
    }
  }

  // Unknown token format
  loggers.realtime.warn('Socket.IO: Unknown token format', { tokenPrefix: token.substring(0, 8) });
  return next(new Error('Authentication error: Invalid token format.'));
});

io.on('connection', (socket: AuthSocket) => {
  loggers.realtime.info('User connected', { socketId: socket.id });
  const user = socket.data.user;

  // Register socket in the registry for permission revocation tracking
  if (user?.id) {
    socketRegistry.registerSocket(user.id, socket.id);
  }

  // Auto-join user's personal rooms on connection
  if (user?.id) {
    const notificationRoom = `notifications:${user.id}`;
    const taskRoom = `user:${user.id}:tasks`;
    const calendarRoom = `user:${user.id}:calendar`;
    const userDrivesRoom = `user:${user.id}:drives`;
    const globalRoom = globalChannelId(user.id);
    socket.join(notificationRoom);
    socket.join(taskRoom);
    socket.join(calendarRoom);
    socket.join(userDrivesRoom);
    socket.join(globalRoom);
    // Track in registry (these are always-on rooms, not permission-gated)
    socketRegistry.trackRoomJoin(socket.id, notificationRoom);
    socketRegistry.trackRoomJoin(socket.id, taskRoom);
    socketRegistry.trackRoomJoin(socket.id, calendarRoom);
    socketRegistry.trackRoomJoin(socket.id, userDrivesRoom);
    socketRegistry.trackRoomJoin(socket.id, globalRoom);
    loggers.realtime.debug('User joined notification, task, calendar, drives, and global rooms', {
      userId: user.id,
      rooms: [notificationRoom, taskRoom, calendarRoom, userDrivesRoom, globalRoom]
    });
  }

  socket.on('join_channel', async (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload before any DB query
    const validation = validatePageId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_channel payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'join_channel', validation.error);
      return;
    }
    const pageId = validation.value;

    try {
      const accessLevel = await getUserAccessLevel(user.id, pageId);
      if (accessLevel) {
        socket.join(pageId);
        socketRegistry.trackRoomJoin(socket.id, pageId);
        loggers.realtime.debug('User joined channel', { userId: user.id, channelId: pageId });
      } else {
        loggers.realtime.warn('User denied access to channel', { userId: user.id, channelId: pageId });
        socket.disconnect();
      }
    } catch (error) {
      loggers.realtime.error('Error joining channel', error as Error, { channelId: pageId });
      socket.disconnect();
    }
  });

  socket.on('leave_channel', (payload: unknown) => {
    if (!user?.id) return;
    const validation = validatePageId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid leave_channel payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'leave_channel', validation.error);
      return;
    }
    const pageId = validation.value;
    socket.leave(pageId);
    socketRegistry.trackRoomLeave(socket.id, pageId);
    loggers.realtime.debug('User left channel', { userId: user.id, channelId: pageId });
  });

  socket.on('join_drive', async (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload before any DB query
    const validation = validateDriveId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_drive payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'join_drive', validation.error);
      return;
    }
    const driveId = validation.value;

    try {
      const hasAccess = await getUserDriveAccess(user.id, driveId);
      if (hasAccess) {
        const driveRoom = `drive:${driveId}`;
        const driveCalendarRoom = `drive:${driveId}:calendar`;
        socket.join(driveRoom);
        socket.join(driveCalendarRoom);
        socketRegistry.trackRoomJoin(socket.id, driveRoom);
        socketRegistry.trackRoomJoin(socket.id, driveCalendarRoom);
        loggers.realtime.debug('User joined drive and drive calendar rooms', {
          userId: user.id,
          rooms: [driveRoom, driveCalendarRoom],
        });
      } else {
        loggers.realtime.warn('User denied access to drive', { userId: user.id, driveId });
      }
    } catch (error) {
      loggers.realtime.error('Error joining drive', error as Error, { driveId });
    }
  });

  // Join a direct message conversation room after membership verification
  // Security: Uses filter-in-query pattern - authorization is part of the query, not post-query
  socket.on('join_dm_conversation', async (payload: unknown) => {
    const userId = user?.id;
    if (!userId) return;

    // Validate payload before any DB query
    const validation = validateConversationId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_dm_conversation payload', { userId, error: validation.error });
      emitValidationError(socket, 'join_dm_conversation', validation.error);
      return;
    }
    const conversationId = validation.value;

    try {
      // Filter-in-query: Authorization is part of the WHERE clause
      // Only returns a row if the user is a participant
      const [conversation] = await db
        .select({ id: dmConversations.id })
        .from(dmConversations)
        .where(
          and(
            eq(dmConversations.id, conversationId),
            or(
              eq(dmConversations.participant1Id, userId),
              eq(dmConversations.participant2Id, userId)
            )
          )
        )
        .limit(1);

      if (!conversation) {
        loggers.realtime.warn('DM join denied: not a participant or not found', { userId, conversationId });
        return;
      }

      const room = `dm:${conversationId}`;
      socket.join(room);
      socketRegistry.trackRoomJoin(socket.id, room);
      loggers.realtime.debug('User joined DM room', { userId, room });
    } catch (error) {
      loggers.realtime.error('Error joining DM conversation', error as Error, { conversationId });
    }
  });

  socket.on('leave_dm_conversation', (payload: unknown) => {
    const userId = user?.id;
    if (!userId) return;

    // Validate payload - leave operations still need format validation
    const validation = validateConversationId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid leave_dm_conversation payload', { userId, error: validation.error });
      emitValidationError(socket, 'leave_dm_conversation', validation.error);
      return;
    }
    const conversationId = validation.value;

    const room = `dm:${conversationId}`;
    socket.leave(room);
    socketRegistry.trackRoomLeave(socket.id, room);
    loggers.realtime.debug('User left DM room', { userId, room });
  });

  socket.on('leave_drive', (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload
    const validation = validateDriveId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid leave_drive payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'leave_drive', validation.error);
      return;
    }
    const driveId = validation.value;

    const driveRoom = `drive:${driveId}`;
    const driveCalendarRoom = `drive:${driveId}:calendar`;
    socket.leave(driveRoom);
    socket.leave(driveCalendarRoom);
    socketRegistry.trackRoomLeave(socket.id, driveRoom);
    socketRegistry.trackRoomLeave(socket.id, driveCalendarRoom);
    loggers.realtime.debug('User left drive and drive calendar rooms', {
      userId: user.id,
      rooms: [driveRoom, driveCalendarRoom],
    });
  });

  // Activity channel handlers - for real-time activity feed updates
  socket.on('join_activity_drive', async (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload before any DB query
    const validation = validateDriveId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_activity_drive payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'join_activity_drive', validation.error);
      return;
    }
    const driveId = validation.value;

    try {
      const hasAccess = await getUserDriveAccess(user.id, driveId);
      if (hasAccess) {
        const activityRoom = `activity:drive:${driveId}`;
        socket.join(activityRoom);
        socketRegistry.trackRoomJoin(socket.id, activityRoom);
        loggers.realtime.debug('User joined activity drive room', { userId: user.id, room: activityRoom });
      } else {
        loggers.realtime.warn('User denied access to activity drive', { userId: user.id, driveId });
      }
    } catch (error) {
      loggers.realtime.error('Error joining activity drive', error as Error, { driveId });
    }
  });

  socket.on('join_activity_page', async (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload before any DB query
    const validation = validatePageId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_activity_page payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'join_activity_page', validation.error);
      return;
    }
    const pageId = validation.value;

    try {
      const accessLevel = await getUserAccessLevel(user.id, pageId);
      if (accessLevel) {
        const activityRoom = `activity:page:${pageId}`;
        socket.join(activityRoom);
        socketRegistry.trackRoomJoin(socket.id, activityRoom);
        loggers.realtime.debug('User joined activity page room', { userId: user.id, room: activityRoom });
      } else {
        loggers.realtime.warn('User denied access to activity page', { userId: user.id, pageId });
      }
    } catch (error) {
      loggers.realtime.error('Error joining activity page', error as Error, { pageId });
    }
  });

  socket.on('leave_activity_drive', (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload
    const validation = validateDriveId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid leave_activity_drive payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'leave_activity_drive', validation.error);
      return;
    }
    const driveId = validation.value;

    const activityRoom = `activity:drive:${driveId}`;
    socket.leave(activityRoom);
    socketRegistry.trackRoomLeave(socket.id, activityRoom);
    loggers.realtime.debug('User left activity drive room', { userId: user.id, room: activityRoom });
  });

  socket.on('leave_activity_page', (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload
    const validation = validatePageId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid leave_activity_page payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'leave_activity_page', validation.error);
      return;
    }
    const pageId = validation.value;

    const activityRoom = `activity:page:${pageId}`;
    socket.leave(activityRoom);
    socketRegistry.trackRoomLeave(socket.id, activityRoom);
    loggers.realtime.debug('User left activity page room', { userId: user.id, room: activityRoom });
  });

  // Presence tracking: join a page as a viewer
  socket.on('presence:join_page', async (payload: unknown) => {
    if (!user?.id) return;

    const pageValidation = validatePresencePagePayload(payload);
    if (!pageValidation.ok) {
      emitValidationError(socket, 'presence:join_page', pageValidation.error);
      return;
    }
    const pageId = pageValidation.value;

    try {
      // Verify the user has access to this page
      const accessLevel = await getUserAccessLevel(user.id, pageId);
      if (!accessLevel) {
        loggers.realtime.warn('Presence denied: no page access', { userId: user.id, pageId });
        return;
      }

      // Look up the page's driveId (user metadata is cached on socket.data from connection)
      const [pageResult] = await db
        .select({ driveId: pages.driveId })
        .from(pages)
        .where(eq(pages.id, pageId))
        .limit(1);

      if (!pageResult) {
        loggers.realtime.warn('Presence: page not found', { pageId });
        return;
      }

      const driveId = pageResult.driveId;

      const presenceUser: PresenceViewer = {
        userId: user.id,
        socketId: socket.id,
        name: user.name,
        avatarUrl: user.avatarUrl,
      };

      presenceTracker.addViewer(pageId, driveId, presenceUser);
      const uniqueViewers = presenceTracker.getUniqueViewers(pageId);

      // Broadcast to the page room (for the content header)
      io.to(pageId).emit('presence:page_viewers', {
        pageId,
        viewers: uniqueViewers,
      });

      // Broadcast to the drive room (for the sidebar page tree)
      io.to(`drive:${driveId}`).emit('presence:page_viewers', {
        pageId,
        viewers: uniqueViewers,
      });

      loggers.realtime.debug('User joined page presence', {
        userId: user.id,
        pageId,
        viewerCount: uniqueViewers.length,
      });
    } catch (error) {
      loggers.realtime.error('Error joining page presence', error as Error, { pageId });
    }
  });

  // Presence tracking: leave a page
  socket.on('presence:leave_page', (payload: unknown) => {
    if (!user?.id) return;

    const pageValidation = validatePresencePagePayload(payload);
    if (!pageValidation.ok) {
      emitValidationError(socket, 'presence:leave_page', pageValidation.error);
      return;
    }
    const pageId = pageValidation.value;

    const driveId = presenceTracker.getDriveId(pageId);
    presenceTracker.removeViewer(socket.id, pageId);
    const uniqueViewers = presenceTracker.getUniqueViewers(pageId);

    // Broadcast updated viewer list to page room
    io.to(pageId).emit('presence:page_viewers', {
      pageId,
      viewers: uniqueViewers,
    });

    // Broadcast to drive room if we know the driveId
    if (driveId) {
      io.to(`drive:${driveId}`).emit('presence:page_viewers', {
        pageId,
        viewers: uniqueViewers,
      });
    }

    loggers.realtime.debug('User left page presence', {
      userId: user.id,
      pageId,
      viewerCount: uniqueViewers.length,
    });
  });

  // Per-event reauth: Sensitive write events re-verify permissions before processing.
  // Currently writes go through HTTP API + broadcast, but this provides defense-in-depth
  // and the pattern for future write event handlers.
  //
  // To wrap future write handlers:
  //   socket.on('page_content_change', withPerEventAuth(socket, 'page_content_change', myHandler, {
  //     pageIdExtractor: (payload: unknown) => (payload as { pageId?: string })?.pageId,
  //   }));
  socket.on('document_update', withPerEventAuth(socket, 'document_update', async (sock, payload) => {
    const data = payload as { pageId: string; content: unknown };
    loggers.realtime.debug('document_update received (with per-event reauth)', {
      userId: sock.data.user?.id,
      pageId: data.pageId,
    });
    // Forward the update to the page room for other participants
    sock.to(data.pageId).emit('document_update', data);
  }, {
    pageIdExtractor: (payload: unknown) => (payload as { pageId?: string })?.pageId,
  }));

  // Agent terminal PTY handlers (Terminal — universal scope reshape) — a
  // named, pluggable-agent-typed session at machine/project/branch scope. A
  // plain machine shell is just a machine-scope agent terminal of
  // `agentType: 'shell'` on this SAME path — the retired human-only
  // `terminal:*` family's replacement — so billing (Terminal Epic 3) meters
  // every agent-terminal connection's active-runtime cost against the
  // machine's payer uniformly, not only the human-shell case.
  const agentTerminalHandlers = buildAgentTerminalHandlers({
    ...agentTerminalSessionDeps,
    socket: socket as unknown as SocketLike,
  });

  socket.on('agent-terminal:connect', (payload) => {
    agentTerminalHandlers.onConnect(payload).then(() => {
      // Same `connectionId ?? socket.id` fallback `onConnect` itself uses —
      // several split panes can share this one socket, each under its own
      // connectionId, so a bare `socket.id` lookup would only ever find
      // whichever pane never sent one.
      const payloadConnectionId =
        payload !== null && typeof payload === 'object' && typeof (payload as { connectionId?: unknown }).connectionId === 'string'
          ? (payload as { connectionId: string }).connectionId
          : undefined;
      const session = agentTerminalSessionMap.getBySocket(payloadConnectionId ?? socket.id);
      if (session) {
        loggers.realtime.info('Agent terminal session opened', { userId: user?.id, sessionKey: session.sessionKey, sandboxId: session.sandboxId });
      }
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Internal error';
      socket.emit('agent-terminal:error', { message: msg });
    });
  });
  socket.on('agent-terminal:input', (payload) => agentTerminalHandlers.onInput(payload));
  socket.on('agent-terminal:resize', (payload) => agentTerminalHandlers.onResize(payload));
  socket.on('agent-terminal:disconnect', (payload) => agentTerminalHandlers.onDisconnect(payload));

  socket.on('disconnect', (reason) => {
    agentTerminalHandlers.onDisconnect();
    // Clean up presence tracking and broadcast updates for affected pages
    const affectedPages = presenceTracker.removeSocket(socket.id);
    for (const { pageId, driveId } of affectedPages) {
      const uniqueViewers = presenceTracker.getUniqueViewers(pageId);

      io.to(pageId).emit('presence:page_viewers', {
        pageId,
        viewers: uniqueViewers,
      });

      if (driveId) {
        io.to(`drive:${driveId}`).emit('presence:page_viewers', {
          pageId,
          viewers: uniqueViewers,
        });
      }
    }

    // Unregister socket from registry (cleans up all room tracking)
    socketRegistry.unregisterSocket(socket.id);
    loggers.realtime.info('User disconnected', { socketId: socket.id, reason });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  loggers.realtime.info(`Socket.IO server ready on port ${PORT}`, { port: PORT });
});
