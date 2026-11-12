import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { takedownRequestSchema } from '@pagespace/lib/content-safety/takedown-request';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateServiceSecret } from '@/lib/auth/service-secret';
import { TakedownRequestError, executeTakedown } from '@/lib/content-safety/takedown-service';

/**
 * POST /api/internal/content-safety/takedown
 *
 * Executes a content takedown. Called only by the admin app
 * (apps/admin/src/app/api/admin/content/takedown/route.ts), which has already
 * authenticated the admin, validated the request and written the audit event.
 *
 * It lives in the web app because takedown needs both S3 clients — the private
 * uploads bucket and the public publish bucket — and only the web app holds
 * credentials for both. The admin app has no S3 access at all.
 *
 * Auth: the shared service secret (see lib/auth/service-secret.ts). As defence
 * in depth the acting user must also be an admin in the database, so a leaked
 * secret alone cannot run a takedown in an arbitrary user's name.
 *
 * A step that fails is not an HTTP error: the response is 200 with
 * `status: 'open'` and `failedStep`, and the case is left resumable.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticateServiceSecret(request);
  if (!auth.ok) return auth.response;

  const [actor] = await db.select({ role: users.role }).from(users).where(eq(users.id, auth.userId)).limit(1);
  if (actor?.role !== 'admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = takedownRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid takedown request', details: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  try {
    return Response.json(await executeTakedown(parsed.data, auth.userId));
  } catch (error) {
    if (error instanceof TakedownRequestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    // The hash, IDs and reason stay out of the log line; the case and the audit event carry them.
    loggers.security.error('Content takedown failed', error instanceof Error ? error : undefined, {
      action: parsed.data.action,
    });
    return Response.json({ error: 'Takedown failed' }, { status: 500 });
  }
}
