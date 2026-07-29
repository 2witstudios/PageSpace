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
import { getSandboxSessionSecret } from '@pagespace/lib/services/sandbox/machine-session-manager';
import { defaultSandboxBillingDeps } from '@pagespace/lib/services/sandbox/sandbox-billing';
import { checkMachineRuntimeGuardrail, recordMachineActivity, acquireCodeExecutionSlot, releaseCodeExecutionSlot } from '@pagespace/lib/services/sandbox/quota';
import { createSpritesSandboxClient, createSpriteHandleCache, type SpritesSdk } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { createSpriteSandboxHost } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-sandbox-host';
import {
  createSpriteTasksClient,
  createTaskHoldController,
  taskHoldName,
  resolveTaskHoldConfig,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprite-tasks';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { createTerminalSessionMap, type TerminalSession } from './terminal/terminal-session-map';
import { openPtyShell } from './terminal/sprites-shell';
import { getRealtimeSpritesSdk } from './terminal/realtime-sprites-client';
import {
  buildShellHandlers,
  ensureShellSession,
  armIdleReap as armShellIdleReap,
  type ShellSessionDeps,
  type SocketLike as ShellSocketLike,
} from './terminal/shell-handler';
import { buildShellCheckAuth } from './terminal/shell-access';
import { deriveShellSessionKey } from './terminal/shell-session-key';
import { handleShellReadRequest, handleShellSendRequest } from './terminal/shell-io';
import { handleShellActivityRequest } from './terminal/shell-activity';
import { checkAgentSessionAccess } from '@pagespace/lib/services/agent-sessions/agent-session-access';
import { resolveSessionShellById } from '@pagespace/lib/services/agent-sessions/session-shells';
import { createDbSessionShellStore } from '@pagespace/lib/services/agent-sessions/session-shells-store';
import { createDbAgentSessionStore } from '@pagespace/lib/services/agent-sessions/agent-sessions-store';
import { ensureAgentSessionSandbox } from '@pagespace/lib/services/agent-sessions/agent-session-sprite';
import { resolveSandboxNetworkOptions } from '@pagespace/lib/services/sandbox/network-options';
import { getConfiguredEgressIpTag } from '@pagespace/lib/services/sandbox/egress-ip';
import { conversations } from '@pagespace/db/schema/conversations';
import {
  validatePageId,
  validateDriveId,
  validateConversationId,
  validatePresencePagePayload,
  emitValidationError,
} from './validation';
import { loggers, initializeLogging } from '@pagespace/lib/logging/logger-config';
import { decryptField } from '@pagespace/lib/encryption/field-crypto';
// Room names come EXCLUSIVELY from the shared grammar (#2158) — the same
// module the broadcast-audience validator checks against, so a join shape
// added here is automatically broadcastable (and vice versa). The drift guard
// (__tests__/room-grammar-drift-guard.test.ts) rejects hand-rolled room names.
import {
  notificationsRoom,
  userTasksRoom,
  userCalendarRoom,
  userDrivesRoom,
  userGlobalRoom,
  driveRoom,
  driveCalendarRoom,
  dmRoom,
  driveActivityRoom,
  pageActivityRoom,
} from '@pagespace/lib/realtime/rooms';
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

// One map for every live shell PTY, keyed by its own sessionKey — a session's
// shared Sprite can host several of these concurrently.
const agentTerminalSessionMap = createTerminalSessionMap();

// The shell:* family's stores (agent sessions + their shells) — created once
// at module level, not per-connection.
const dbAgentSessionStorePromise = createDbAgentSessionStore();
const dbSessionShellStorePromise = createDbSessionShellStore();

/**
 * Decrypt PII at the edge (GDPR #965): actorEmail is denormalized into a
 * plaintext activity-log/audit snapshot downstream (writeCodeExecutionAudit),
 * not an encrypted column, so a ciphertext users.email must never reach it.
 * Extracted as a pure helper (rather than inlined in `buildShellCheckAuth`)
 * so it's directly unit-testable without mocking the rest of the shell-auth
 * pipeline (sandbox provisioning, sprites SDK, audit sink).
 */
export async function resolveActorEmail(rawEmail: string | null | undefined): Promise<string> {
  return rawEmail ? await decryptField(rawEmail) : '';
}

/**
 * A page's CURRENT driveId + that drive's owner (the `tenantId` convention the
 * Sprite session-key derivation uses) — shared by every call site below that
 * needs "which drive owns this agent page, and who pays" without risking a
 * stale cross-drive lookup.
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

// ---------------------------------------------------------------------------
// shell:* family — the PTY bridge re-keyed onto agent sessions (Phase 3).
//
// A shell's whole wire address is `{shellId}`: the bridge resolves shell row →
// session → sandbox. Authorization is the SAME pure `decideAgentSessionAccess`
// verdict the web API routes enforce (via `checkAgentSessionAccess`), and
// provisioning is the SAME `ensureAgentSessionSandbox` path the web tier uses —
// one code path, so concurrent provisioners CAS against one store instead of
// fighting. The legacy `agent-terminal:*` family (machine/project/branch-scope
// PTYs) was deleted in the Phase 8 teardown.
// ---------------------------------------------------------------------------

/**
 * Ensure (create/resume/adopt) the session's ONE shared sandbox — the
 * `ensureSessionSandbox` seam of `buildShellCheckAuth`, backed by the shared
 * packages/lib provisioner and NEVER a realtime-local one. `tenantId` (the
 * Sprite-key fold's tenant and the billing account) is the agent page's drive
 * owner, falling back to the session's own owner for a global-assistant
 * session — the same `agentPageId ?? ownerId` attribution rule billing uses.
 */
async function ensureShellSessionSandbox({ sessionId, userId }: { sessionId: string; userId: string }): Promise<
  { ok: true; sandboxId: string } | { ok: false; reason: string }
> {
  const store = await dbAgentSessionStorePromise;
  const row = await store.findById(sessionId);
  if (!row) return { ok: false, reason: 'session_not_found' };

  let tenantId: string;
  if (row.agentPageId === null) {
    tenantId = row.ownerId;
  } else {
    const context = await resolveDriveOwnerContext(row.agentPageId);
    if (!context.ok) return { ok: false, reason: context.reason };
    tenantId = context.tenantId;
  }

  const sdk = createSpriteHandleCache(await getRealtimeSpritesSdk());
  const host = createSpriteSandboxHost({ sdk, client: createSpritesSandboxClient({ sdk }) });

  const result = await ensureAgentSessionSandbox({
    row: { ...row, sessionId: row.conversationId },
    intent: 'ensure',
    actor: { userId, tenantId },
    deps: {
      store,
      host,
      substrate: { kind: 'sprite' },
      options: resolveSandboxNetworkOptions({ surface: 'machine', egressIpTag: getConfiguredEgressIpTag() }),
      secret: getSandboxSessionSecret(),
      // SECURITY: the centralized code-execution gate, applied inside the
      // shared provisioner before any Sprite is provisioned OR handed back —
      // the same fail-closed checker the access half already consulted.
      authorize: canRunCode,
      resolveDriveId: async (agentPageId) => {
        const context = await resolveDriveOwnerContext(agentPageId);
        return context.ok ? context.driveId : null;
      },
      checkFullEgressEnablement: async () =>
        decideFullEgressEnablement({
          adminGateEnabled: isCodeExecutionEnabled(),
          containment: isContainmentVerified() ? { contained: true } : null,
        }),
      now: () => new Date(),
    },
  });
  if (!result.ok) return { ok: false, reason: result.denial ?? result.reason };
  return { ok: true, sandboxId: result.sandboxId };
}

/**
 * Auth for a shell connect: shell row → owning session → the ONE session access
 * decision, with the Sprite half handed back as an uncalled thunk (see
 * `shell-access.ts`). Every dep here is DB-only except the thunk's own
 * provisioning pair.
 */
const shellCheckAuth = buildShellCheckAuth({
  resolveShell: async (shellId) => {
    const store = await dbSessionShellStorePromise;
    return resolveSessionShellById({ shellId, deps: { store } });
  },
  checkSessionAccess: async ({ requesterId, sessionId }) => {
    const store = await dbAgentSessionStorePromise;
    const row = await store.findById(sessionId);
    if (!row) return { allowed: false, reason: 'session_not_found' };
    const subject = { sessionId: row.conversationId, ownerId: row.ownerId, agentPageId: row.agentPageId };
    const decision = await checkAgentSessionAccess({
      requesterId,
      sessionId,
      deps: {
        // The row was just read; hand the wrapper the same subject rather than
        // paying a second lookup for the identical answer.
        findSession: async () => subject,
        resolveConversationOwnership: async ({ conversationId, requesterId: rid }) => {
          const [conversation] = await db
            .select({ userId: conversations.userId, isShared: conversations.isShared })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .limit(1);
          if (!conversation) return 'none';
          if (conversation.userId === rid) return 'owner';
          return conversation.isShared ? 'shared' : 'none';
        },
        resolvePagePermission: async ({ userId, agentPageId }) => {
          const level = await getUserAccessLevel(userId, agentPageId);
          if (!level) return null;
          return level.canEdit ? 'edit' : 'view';
        },
        canRunCode: async ({ userId, agentPageId }) => {
          // Drive-scoped for a page session; global (no driveId) otherwise. An
          // unresolvable drive fails closed.
          const context = agentPageId === null ? null : await resolveDriveOwnerContext(agentPageId);
          if (agentPageId !== null && !context?.ok) return false;
          const verdict = await canRunCode({
            userId,
            driveId: context?.ok ? context.driveId : undefined,
            requestOrigin: 'user',
          });
          return verdict.ok;
        },
      },
    });
    return decision.allowed ? { allowed: true, session: subject } : decision;
  },
  resolvePayer: async (session) => {
    // Payer = the agent page's drive owner; a global-assistant session (or an
    // orphaned page) attributes to the session owner instead.
    if (session.agentPageId === null) return { payerId: session.ownerId, driveId: null };
    const context = await resolveDriveOwnerContext(session.agentPageId);
    if (!context.ok) return { payerId: session.ownerId, driveId: null };
    return { payerId: context.tenantId, driveId: context.driveId };
  },
  getUser: async (userId) => {
    const [userRow] = await db
      .select({ subscriptionTier: users.subscriptionTier, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return userRow;
  },
  resolveActorEmail,
  acquireSlot: ({ userId, tier }) => acquireCodeExecutionSlot({ userId, tier }),
  releaseSlot: (userId) => releaseCodeExecutionSlot({ userId }),
  ensureSessionSandbox: ensureShellSessionSandbox,
  getSprite: async (sandboxId) => (await getRealtimeSpritesSdk()).getSprite(sandboxId),
  // Write code execution audit record (shell PTY session open) — this launches
  // an arbitrary program (the resolved command, or a per-shell override)
  // inside the session's Sprite. `driveId` is null for a global-assistant
  // session, which the audit record type carries as-is.
  writeAudit: ({ userId, actorEmail, driveId, command }) => {
    writeCodeExecutionAudit({
      input: {
        userId,
        actorEmail,
        driveId,
        requestOrigin: 'user',
        profile: 'pty',
        code: `[Shell session opened: ${command}]`,
        exitCode: null,
        durationMs: 0,
        timestamp: new Date(),
      },
    }).catch(() => {});
  },
  buildSessionKey: ({ shellId }) => deriveShellSessionKey({ shellId }),
  logDenied: (reason, context) => loggers.realtime.warn('Shell auth denied', { reason, ...context }),
  logSandboxLookupFailed: (context) => loggers.realtime.warn('Shell sandbox lookup failed', { reason: 'provision_failed', ...context }),
});

/**
 * Everything it takes to START a shell PTY, wired once for BOTH callers: a
 * viewer's `shell:connect` and a headless start driven by agent IO over signed
 * HTTP (`startHeadlessShell`). Shares the ONE process-wide session map with the
 * legacy family — the two key namespaces cannot collide (see
 * `deriveShellSessionKey`) — and the same billing + task-hold seams.
 */
const shellSessionDeps: ShellSessionDeps = {
  sessionMap: agentTerminalSessionMap,
  openShell: openPtyShell,
  checkAuth: shellCheckAuth,
  persistStreamSessionId: async ({ shellId, sessionId }) => {
    const store = await dbSessionShellStorePromise;
    await store.updateStreamSessionId({ id: shellId, streamSessionId: sessionId, now: new Date() });
  },
  persistColdTail: async ({ shellId, tail, hasOutput, endedAt }) => {
    const store = await dbSessionShellStorePromise;
    await store.recordColdTail({ id: shellId, tail, hasOutput, endedAt });
  },
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
 * window (`shell:resize`), so this only ever governs the wrapping of output
 * produced before anyone looked.
 */
const HEADLESS_COLS = 80;
const HEADLESS_ROWS = 24;

/**
 * Start a PTY for an agent reading or typing into a shell whose session has
 * never run (issue #2206) — the `startSession` seam of `shell-io.ts`.
 * Authorization is decided HERE, against the userId the (signed) request
 * names: starting a sandbox process reserves that user's concurrency slot,
 * bills the session's payer, and writes a code-execution audit row.
 */
const startHeadlessShell = async (
  { shellId, userId }: { shellId: string; userId: string },
  abandoned: () => boolean,
) => {
  const access = await shellCheckAuth({ userId, shellId });
  if (!access.ok) return undefined;

  const outcome = await ensureShellSession(shellSessionDeps, {
    access,
    target: { shellId },
    userId,
    cols: HEADLESS_COLS,
    rows: HEADLESS_ROWS,
    abandoned,
  });
  if (outcome.kind === 'failed') return undefined;
  loggers.realtime.info('Shell session started headlessly', {
    sessionKey: access.sessionKey,
    sandboxId: outcome.session.sandboxId,
    reused: outcome.kind === 'existing',
  });
  return outcome.session;
};

/** The shell-IO deps both HTTP verbs share — the map, the key derivation, and the two effects. */
const shellIoDeps = {
  sessionMap: agentTerminalSessionMap,
  sessionKeyFor: (shellId: string) => deriveShellSessionKey({ shellId }),
  startSession: startHeadlessShell,
  rearmIdleReap: (session: TerminalSession) =>
    armShellIdleReap(shellSessionDeps, agentTerminalSessionMap, session),
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
     * `start: true` path can run a cold Sprite wake past even the web tier's
     * own generous `fetch` timeout for that shape (`COLD_START_TIMEOUT_MS`,
     * `session-io-pty.ts`), and this is how `ensureAgentTerminalSession`'s
     * `abandoned()` check — the same one a viewer's socket connect uses —
     * learns to bail rather than start a PTY (and write input into it) for a
     * caller who already gave up and may retry.
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
    } else if (req.method === 'POST' && req.url === '/api/shell-read') {
        // read_shell (shell:* family) + the liveness sweep, re-keyed to
        // {shellId}. The bytes live in THIS process's session map, so the web
        // tier — which has already authorized the shell against the shared
        // session access decision — asks for them over a signed POST.
        readCappedBody(body => {
            const signatureHeader = req.headers['x-broadcast-signature'] as string;
            if (!verifySignature(signatureHeader, body)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Authentication failed' }));
                return;
            }

            handleShellReadRequest(shellIoDeps, body, trackRequestAbandonment()).then((result) => {
                res.writeHead(result.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result.body));
            }).catch((error: unknown) => {
                loggers.realtime.error('Shell read request failed', error instanceof Error ? error : new Error(String(error)));
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Internal error' }));
            });
        });
    } else if (req.method === 'POST' && req.url === '/api/shell-input') {
        // send_shell (shell:* family): types stdin into a live shell PTY
        // through the same `session.command.write` a human viewer's keystroke
        // takes, so anyone watching sees it echoed exactly as they would see a
        // teammate type.
        readCappedBody(body => {
            const signatureHeader = req.headers['x-broadcast-signature'] as string;
            if (!verifySignature(signatureHeader, body)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Authentication failed' }));
                return;
            }

            handleShellSendRequest(shellIoDeps, body, undefined, trackRequestAbandonment()).then((result) => {
                res.writeHead(result.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result.body));
            }).catch((error: unknown) => {
                loggers.realtime.error('Shell input request failed', error instanceof Error ? error : new Error(String(error)));
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Internal error' }));
            });
        });
    } else if (req.method === 'POST' && req.url === '/api/shell-activity') {
        // Streams an agent's bash run into the live shell feeds of its SESSION
        // (the shell:* successor to /api/terminal-activity, addressed by
        // sessionId). Best-effort: no live shell (nobody watching) is not an
        // error.
        readCappedBody(body => {
            const signatureHeader = req.headers['x-broadcast-signature'] as string;
            if (!verifySignature(signatureHeader, body)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Authentication failed' }));
                return;
            }

            handleShellActivityRequest(
                {
                    sessionMap: agentTerminalSessionMap,
                    // A DB-only listing of the session's shells composed with the
                    // pure key derivation — no Sprite is resolved or woken to
                    // answer "is anyone watching".
                    resolveShellKeys: async (sessionId) => {
                        const store = await dbSessionShellStorePromise;
                        const rows = await store.list(sessionId);
                        return rows.map((row) => deriveShellSessionKey({ shellId: row.id }));
                    },
                },
                body,
            ).then((result) => {
                res.writeHead(result.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result.body));
            }).catch((error: unknown) => {
                loggers.realtime.error('Shell activity request failed', error instanceof Error ? error : new Error(String(error)));
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
    const personalRooms = [
      notificationsRoom(user.id),
      userTasksRoom(user.id),
      userCalendarRoom(user.id),
      userDrivesRoom(user.id),
      userGlobalRoom(user.id),
    ];
    for (const room of personalRooms) {
      socket.join(room);
      // Track in registry (these are always-on rooms, not permission-gated)
      socketRegistry.trackRoomJoin(socket.id, room);
    }
    loggers.realtime.debug('User joined notification, task, calendar, drives, and global rooms', {
      userId: user.id,
      rooms: personalRooms
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
        const rooms = [driveRoom(driveId), driveCalendarRoom(driveId)];
        for (const room of rooms) {
          socket.join(room);
          socketRegistry.trackRoomJoin(socket.id, room);
        }
        loggers.realtime.debug('User joined drive and drive calendar rooms', {
          userId: user.id,
          rooms,
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

      const room = dmRoom(conversationId);
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

    const room = dmRoom(conversationId);
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

    const rooms = [driveRoom(driveId), driveCalendarRoom(driveId)];
    for (const room of rooms) {
      socket.leave(room);
      socketRegistry.trackRoomLeave(socket.id, room);
    }
    loggers.realtime.debug('User left drive and drive calendar rooms', {
      userId: user.id,
      rooms,
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
        const activityRoom = driveActivityRoom(driveId);
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
        const activityRoom = pageActivityRoom(pageId);
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

    const activityRoom = driveActivityRoom(driveId);
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

    const activityRoom = pageActivityRoom(pageId);
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
      io.to(driveRoom(driveId)).emit('presence:page_viewers', {
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
      io.to(driveRoom(driveId)).emit('presence:page_viewers', {
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

  // Shell PTY handlers (shell:* family): a named PTY inside its
  // agent session's ONE shared sandbox, addressed by `{shellId}` alone. Billing
  // meters every connection's active-runtime cost against the session's payer
  // (agent page's drive owner, or the session owner for a global-assistant
  // session).
  const shellHandlers = buildShellHandlers({
    ...shellSessionDeps,
    socket: socket as unknown as ShellSocketLike,
  });

  socket.on('shell:connect', (payload) => {
    shellHandlers.onConnect(payload).then(() => {
      // Same `connectionId ?? socket.id` fallback `onConnect` itself uses —
      // several panes can share this one socket, each under its own
      // connectionId, so a bare `socket.id` lookup would only ever find
      // whichever pane never sent one.
      const payloadConnectionId =
        payload !== null && typeof payload === 'object' && typeof (payload as { connectionId?: unknown }).connectionId === 'string'
          ? (payload as { connectionId: string }).connectionId
          : undefined;
      const session = agentTerminalSessionMap.getBySocket(`${socket.id}\u0000${payloadConnectionId ?? socket.id}`);
      if (session) {
        loggers.realtime.info('Shell session opened', { userId: user?.id, sessionKey: session.sessionKey, sandboxId: session.sandboxId });
      }
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Internal error';
      socket.emit('shell:error', { message: msg });
    });
  });
  socket.on('shell:input', (payload) => shellHandlers.onInput(payload));
  socket.on('shell:resize', (payload) => shellHandlers.onResize(payload));
  socket.on('shell:disconnect', (payload) => shellHandlers.onDisconnect(payload));

  socket.on('disconnect', (reason) => {
    shellHandlers.onDisconnect();
    // Clean up presence tracking and broadcast updates for affected pages
    const affectedPages = presenceTracker.removeSocket(socket.id);
    for (const { pageId, driveId } of affectedPages) {
      const uniqueViewers = presenceTracker.getUniqueViewers(pageId);

      io.to(pageId).emit('presence:page_viewers', {
        pageId,
        viewers: uniqueViewers,
      });

      if (driveId) {
        io.to(driveRoom(driveId)).emit('presence:page_viewers', {
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
