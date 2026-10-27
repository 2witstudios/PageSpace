/**
 * nats-log-source — opens one NATS subscription per published app against the
 * org's Fly log firehose (`logs.<fly-app>.<region>.<machine>`, wildcarded here
 * as `logs.<fly-app>.*.*` — one level for region, one for machine id, per the
 * epic's Fly-blueprint research fact). Lazily connects a single shared NATS
 * client on first use; every app subscription rides that one connection.
 *
 * CONFIRMED (founder, [A-publish]): Fly's org-wide 6PN firehose at
 * `nats://[fdaa::3]:4223`, authenticated with the org slug (reused from
 * `resolvePublishedAppsOrgSlug`, the same org every published app is
 * provisioned in) as the NATS username and the Fly-secret-provisioned
 * read-only token as the password. `subscribeToAppLogs` fails closed (throws)
 * if unconfigured (`FLY_LOGS_NATS_TOKEN` unset), and the caller
 * (`app-log-handler.ts`) turns that into a visible "logs unavailable" signal
 * rather than a silent black hole. Reaching `fdaa::3` requires the connecting
 * process to be attached to the org's 6PN network — see the runbook note in
 * `ROUTING.md`.
 *
 * SUBJECT SAFETY: the `flyAppName` passed in here must already be the value
 * read back from the caller's own `published_apps` row lookup, never an
 * unvalidated client-supplied string — see `app-log-handler.ts`'s
 * `isAuthorizedForAppLogs`, which returns that verified name for exactly this
 * reason. This function does not re-check authorization; it trusts its caller
 * to have already resolved the argument from the database.
 */

import { connect, type NatsConnection, type Subscription } from 'nats';
import {
  resolveAppLogsNatsUrl,
  resolveAppLogsNatsToken,
  isAppLogsNatsConfigured,
} from '@pagespace/lib/services/app-hosting/app-logs-env';
import { resolvePublishedAppsOrgSlug } from '@pagespace/lib/services/app-hosting/app-hosting-env';
import { loggers } from '@pagespace/lib/logging/logger-config';

let sharedConnection: Promise<NatsConnection> | undefined;

function getConnection(): Promise<NatsConnection> {
  if (!sharedConnection) {
    sharedConnection = connect({
      servers: resolveAppLogsNatsUrl(),
      user: resolvePublishedAppsOrgSlug(),
      pass: resolveAppLogsNatsToken(),
    }).catch((error) => {
      // A failed connect must not poison every future subscription attempt —
      // the next caller should retry rather than inherit a rejected promise.
      sharedConnection = undefined;
      throw error;
    });
  }
  return sharedConnection;
}

export type AppLogSubscription = {
  unsubscribe: () => void;
};

/**
 * Subscribe to one Fly app's log subject and call `onLine` for every message.
 * Throws if the firehose is not configured — callers must check
 * `isAppLogsNatsConfigured()` first if they want to surface that as a
 * user-facing state rather than an error path.
 */
export async function subscribeToAppLogs(
  flyAppName: string,
  onLine: (message: string) => void,
): Promise<AppLogSubscription> {
  if (!isAppLogsNatsConfigured()) {
    throw new Error('App-hosting log firehose is not configured (FLY_LOGS_NATS_TOKEN unset)');
  }

  const nc = await getConnection();
  const sub: Subscription = nc.subscribe(`logs.${flyAppName}.*.*`);

  void (async () => {
    for await (const msg of sub) {
      try {
        onLine(msg.string());
      } catch (error) {
        loggers.realtime.error('Failed to handle app log line', error instanceof Error ? error : new Error(String(error)), {
          flyAppName,
        });
      }
    }
  })();

  return {
    unsubscribe: () => {
      sub.unsubscribe();
    },
  };
}
