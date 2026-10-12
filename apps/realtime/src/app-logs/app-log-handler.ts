/**
 * app-log-handler — the realtime bridge for a published app's log pane.
 *
 * Contract (fixed — the web client is built against these exact names):
 *   client → server `app:logs:subscribe`   { envId, flyAppName }
 *   server → client `app:logs:line`        { flyAppName, message, timestamp }
 *   client → server `app:logs:unsubscribe` { flyAppName }
 *
 * AUTHORIZATION: the client names an `envId` and a `flyAppName`; neither is
 * trusted alone, and the `flyAppName` actually used for the NATS subscription
 * is NEVER the client's copy. The env has to resolve to a drive the caller is
 * a member of (`getUserDriveAccess`, the same predicate `join_drive` uses),
 * AND that env's OWN `published_apps` row has to carry a `flyAppName`
 * matching the claim — otherwise a member of drive A could subscribe to
 * drive B's app logs by naming its `flyAppName` under an env they
 * legitimately own. `resolveAuthorizedFlyAppName` returns the DB-read value
 * on success, and every downstream use (the session map key, the NATS
 * subject) is built from THAT return, not from `payload.flyAppName` — so a
 * client cannot get its own unvalidated string anywhere near the subject.
 * Both checks are a single query away and run before any NATS subscription
 * is ever opened.
 *
 * IDLE TEARDOWN mirrors the shell bridge's shape at a much smaller scale: the
 * last viewer leaving arms a short timer that closes the NATS subscription if
 * nobody re-attaches — logs are read-only and cheap to resume, so there is no
 * 30-minute grace to preserve, just enough delay (`IDLE_UNSUBSCRIBE_MS`) to
 * absorb a page navigation that resubscribes a moment later.
 */

import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isAppLogsNatsConfigured } from '@pagespace/lib/services/app-hosting/app-logs-env';
import { subscribeToAppLogs } from './nats-log-source';
import {
  createAppLogSessionMap,
  broadcastLogLine,
  type AppLogSessionMap,
} from './app-log-session-map';

export const IDLE_UNSUBSCRIBE_MS = 60_000;

export type AppLogSocketLike = {
  id: string;
  data: { user?: { id: string }; actor?: AccessActor };
  emit(event: string, payload?: unknown): void;
};

/**
 * The socket's org-room watch (SEC-2/3): an app's log stream is org content of the env's drive, so each subscription is
 * tracked like a joined org room — the watch re-decides it at the credential's maximum-age expiry and on a policy
 * change, and an eviction reaches `onEvicted`, which tears the stream down.
 */
export type AppLogWatchLink = {
  track(room: string, resourceId: string): void | Promise<void>;
  untrack(room: string): void;
};

const APP_LOG_ROOM_PREFIX = 'app-logs:';

/** The pseudo-room an app's log stream is tracked under in the socket's org-room watch. */
export function appLogRoom(flyAppName: string): string {
  return `${APP_LOG_ROOM_PREFIX}${flyAppName}`;
}

function isSubscribePayload(payload: unknown): payload is { envId: string; flyAppName: string } {
  if (payload === null || typeof payload !== 'object') return false;
  const { envId, flyAppName } = payload as Record<string, unknown>;
  return typeof envId === 'string' && envId.length > 0 && typeof flyAppName === 'string' && flyAppName.length > 0;
}

function isUnsubscribePayload(payload: unknown): payload is { flyAppName: string } {
  if (payload === null || typeof payload !== 'object') return false;
  const { flyAppName } = payload as Record<string, unknown>;
  return typeof flyAppName === 'string' && flyAppName.length > 0;
}

/**
 * Resolve whether the actor may watch this env's published app's logs — a
 * drive-membership check on the env, cross-checked against the published-app
 * row that env actually has.
 *
 * Returns the DB-VERIFIED `flyAppName`, never the client's copy: the caller
 * must subscribe using THIS value, not the one from the socket payload — a
 * client naming an env it legitimately owns but a `flyAppName` belonging to a
 * different app must never reach the NATS subject construction with its own
 * string. Equality between the two is checked here only to decide whether to
 * authorize at all; the value actually used downstream comes from this
 * function's return, not from trusting that check.
 */
async function resolveAuthorizedFlyAppName(
  actor: AccessActor,
  envId: string,
  claimedFlyAppName: string,
): Promise<{ flyAppName: string; driveId: string } | null> {
  const [env] = await db
    .select({ driveId: driveEnvs.driveId })
    .from(driveEnvs)
    .where(eq(driveEnvs.id, envId))
    .limit(1);
  if (!env) return null;

  const hasAccess = await getUserDriveAccess(actor, env.driveId);
  if (!hasAccess) return null;

  const [app] = await db
    .select({ flyAppName: publishedApps.flyAppName })
    .from(publishedApps)
    .where(eq(publishedApps.envId, envId))
    .limit(1);
  if (!app) return null;

  // The env's ACTUAL app must match what the client claimed — a mismatch means
  // the client named the wrong app (stale UI state, or a probing attempt) and
  // is refused rather than silently subscribed to a different app's logs.
  if (app.flyAppName !== claimedFlyAppName) return null;

  return { flyAppName: app.flyAppName, driveId: env.driveId };
}

export type AppLogHandlers = {
  onSubscribe(payload: unknown): Promise<void>;
  onUnsubscribe(payload: unknown): void;
  onDisconnect(): void;
  /** The org-room watch left `room`: when it is an app's log stream, stop streaming it to this socket. */
  onEvicted(room: string): void;
};

export function buildAppLogHandlers(
  socket: AppLogSocketLike,
  sessionMap: AppLogSessionMap = sharedAppLogSessionMap,
  watch?: AppLogWatchLink,
): AppLogHandlers {
  // Keyed per (socket, app), NOT per socket alone — a single socket watching
  // two apps' logs (two panes open, or switching apps without a reload) must
  // register two independent viewer entries. A single fixed key per socket
  // would let the second subscribe silently steal the session map's pointer
  // to the first (`bySocket` is keyed by viewerKey), orphaning its viewer
  // entry — never cleaned up, its NATS subscription never torn down — the
  // moment the client tried to unsubscribe from or disconnect on either app.
  const viewerKeyFor = (flyAppName: string): string => `${socket.id}:${flyAppName}`;

  // `onDisconnect` carries no payload to say which apps this socket was
  // watching, so that has to be tracked locally rather than reconstructed.
  const activeApps = new Set<string>();

  function armIdleUnsubscribe(flyAppName: string): void {
    const session = sessionMap.getByApp(flyAppName);
    if (!session) return;
    if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.viewers.size > 0) return;
      session.unsubscribe();
      sessionMap.deleteByApp(flyAppName);
    }, IDLE_UNSUBSCRIBE_MS);
  }

  function detach(flyAppName: string): void {
    const session = sessionMap.removeViewer(viewerKeyFor(flyAppName));
    activeApps.delete(flyAppName);
    watch?.untrack(appLogRoom(flyAppName));
    if (session && session.viewers.size === 0) armIdleUnsubscribe(session.flyAppName);
  }

  return {
    async onSubscribe(payload) {
      const userId = socket.data.user?.id;
      const actor = socket.data.actor;
      if (!userId || !actor) return;
      if (!isSubscribePayload(payload)) return;
      const { envId, flyAppName: claimedFlyAppName } = payload;

      let flyAppName: string;
      let driveId: string;
      try {
        const authorized = await resolveAuthorizedFlyAppName(actor, envId, claimedFlyAppName);
        if (!authorized) {
          loggers.realtime.warn('User denied access to app logs', { userId, envId, claimedFlyAppName });
          return;
        }
        ({ flyAppName, driveId } = authorized);
      } catch (error) {
        loggers.realtime.error('Failed to authorize app-log subscribe', error instanceof Error ? error : new Error(String(error)), {
          userId,
          envId,
          claimedFlyAppName,
        });
        return;
      }

      const viewer = {
        emitLine: (line: { flyAppName: string; message: string; timestamp: string }) => {
          socket.emit('app:logs:line', line);
        },
      };

      const viewerKey = viewerKeyFor(flyAppName);

      const existing = sessionMap.getByApp(flyAppName);
      if (existing) {
        if (existing.idleTimer !== undefined) {
          clearTimeout(existing.idleTimer);
          existing.idleTimer = undefined;
        }
        sessionMap.addViewer(flyAppName, viewerKey, viewer);
        activeApps.add(flyAppName);
        void watch?.track(appLogRoom(flyAppName), driveId);
        return;
      }

      if (!isAppLogsNatsConfigured()) {
        loggers.realtime.warn('App-log subscribe requested but the log firehose is not configured', { flyAppName });
        return;
      }

      try {
        const subscription = await subscribeToAppLogs(flyAppName, (message) => {
          const session = sessionMap.getByApp(flyAppName);
          if (session) broadcastLogLine(session, message, new Date().toISOString());
        });

        // A concurrent subscribe for the same app may have installed a session
        // while this one awaited the NATS connect — join it rather than opening
        // a second subscription.
        if (sessionMap.getByApp(flyAppName)) {
          subscription.unsubscribe();
          sessionMap.addViewer(flyAppName, viewerKey, viewer);
          activeApps.add(flyAppName);
          void watch?.track(appLogRoom(flyAppName), driveId);
          return;
        }

        sessionMap.setNew({ flyAppName, unsubscribe: subscription.unsubscribe, viewers: new Map() });
        sessionMap.addViewer(flyAppName, viewerKey, viewer);
        activeApps.add(flyAppName);
        void watch?.track(appLogRoom(flyAppName), driveId);
      } catch (error) {
        loggers.realtime.error('Failed to subscribe to app logs', error instanceof Error ? error : new Error(String(error)), {
          flyAppName,
        });
      }
    },

    onUnsubscribe(payload) {
      if (!isUnsubscribePayload(payload)) return;
      // The claimed `flyAppName` is used ONLY as a lookup key here, never to
      // authorize anything new — it can at most remove a viewer entry that was
      // already created under an authorized subscribe, so an unrecognized or
      // adversarial value just finds nothing to detach.
      detach(payload.flyAppName);
    },

    onDisconnect() {
      // Every app this socket subscribed to, torn down independently — a
      // fixed single-session assumption here is exactly what let one app's
      // detach silently orphan another's viewer entry.
      for (const flyAppName of [...activeApps]) {
        detach(flyAppName);
      }
    },

    onEvicted(room) {
      if (!room.startsWith(APP_LOG_ROOM_PREFIX)) return;
      const flyAppName = room.slice(APP_LOG_ROOM_PREFIX.length);
      if (!activeApps.has(flyAppName)) return;
      detach(flyAppName);
      socket.emit('app:logs:ended', { flyAppName, reason: 'org_sign_in' });
    },
  };
}

/** One process-wide map — log sessions are keyed by `flyAppName`, not per-socket, so every viewer of one app shares the same NATS subscription. */
export const sharedAppLogSessionMap: AppLogSessionMap = createAppLogSessionMap();
