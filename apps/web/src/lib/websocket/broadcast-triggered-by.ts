import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { userProfiles } from '@pagespace/db/schema/members';
import { browserLoggers } from '@pagespace/lib/logging/logger-browser';
import { validateBrowserSessionIdHeader } from '@/lib/ai/core/browser-session-id-validation';

const triggeredByLogger = browserLoggers.realtime.child({ module: 'broadcast-triggered-by' });

export interface TriggeredBy {
  userId: string;
  displayName: string;
  browserSessionId: string;
}

/**
 * Resolve the `triggeredBy` block for chat broadcasts (edits, deletes, undo,
 * conversation creation). Reads the X-Browser-Session-Id header (graceful
 * fail-open: empty string when missing, since these are mutation broadcasts
 * — not stream lifecycle events that require a session id) and resolves the
 * actor's display name from userProfiles → users.name → "Someone".
 */
export async function resolveTriggeredBy(
  userId: string,
  request: Request,
): Promise<TriggeredBy> {
  const sessionResult = validateBrowserSessionIdHeader(
    request.headers.get('X-Browser-Session-Id'),
  );
  const browserSessionId = sessionResult.ok ? sessionResult.browserSessionId : '';

  const [profile] = await db
    .select({ displayName: userProfiles.displayName })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
    .catch((err: unknown) => {
      triggeredByLogger.debug({ err, query: 'userProfiles', userId }, 'displayName query failed; falling back');
      return [] as { displayName: string | null }[];
    });

  let displayName = profile?.displayName ?? null;
  if (!displayName) {
    const [user] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .catch((err: unknown) => {
        triggeredByLogger.debug({ err, query: 'users', userId }, 'displayName query failed; falling back');
        return [] as { name: string | null }[];
      });
    displayName = user?.name ?? 'Someone';
  }

  return { userId, displayName, browserSessionId };
}
