import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import type { ScanEnvironmentFacts } from '@pagespace/lib/content-safety/readiness';
import { resolveScanConfigFromEnv } from '@pagespace/lib/content-safety/scan-mode';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { authenticateServiceSecret } from '@/lib/auth/service-secret';

/**
 * GET /api/internal/content-safety/readiness
 *
 * The web app's own content-scanning environment, for the admin console's
 * enforce-readiness check (apps/admin/src/app/api/admin/content/readiness).
 * Only the web app holds these variables. Booleans and the resolved mode only:
 * never a value.
 *
 * Auth: the shared service secret, and the acting user must be an admin who is
 * not suspended (as for the takedown route).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticateServiceSecret(request);
  if (!auth.ok) return auth.response;

  const [actor] = await db
    .select({ role: users.role, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);
  if (actor?.role !== 'admin' || actor.suspendedAt !== null) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const config = resolveScanConfigFromEnv();
  const set = (name: string) => Boolean(process.env[name]?.trim());
  const facts: ScanEnvironmentFacts = {
    onPrem: isOnPrem(),
    mode: config.mode,
    problems: config.problems,
    hiveKeySet: set('HIVE_API_KEY'),
    evidenceBucketSet: set('EVIDENCE_BUCKET'),
    abuseEmailSet: set('ABUSE_EMAIL'),
    publishBucketSet: set('PUBLISH_BUCKET'),
    allowUnclassifiedVideo: config.allowUnclassifiedVideo,
  };
  return Response.json(facts);
}
