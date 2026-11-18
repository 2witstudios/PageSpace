import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { authenticateServiceSecret } from '@/lib/auth/service-secret';
import { gateAvatarBytes } from '@/lib/content-safety/avatar-gate-service';
import { readBytesWithCap } from '@/lib/http/read-body-with-cap';

/**
 * POST /api/internal/content-safety/avatar-gate
 *
 * Runs the content-safety gate on an avatar upload for the processor
 * (apps/processor/src/services/avatar-gate-client.ts), BEFORE the processor
 * touches the user's current avatar. The body is the raw image bytes.
 *
 * It lives here because the gate's executors do: the vendor key, the review
 * queue and alerts, and for a hash match the global takedown with evidence
 * preservation, which needs the uploads, publish and evidence buckets.
 *
 * Auth: the shared service secret; `x-service-user-id` names the uploader,
 * who must exist. The answer is `{ accept }` and nothing else: the processor
 * shows the uploader a neutral message whatever the reason.
 */

/** The processor accepts 5 MB; anything larger did not come from it. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const auth = authenticateServiceSecret(request);
  if (!auth.ok) return auth.response;

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_AVATAR_BYTES) return Response.json({ error: 'Too large' }, { status: 413 });

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, auth.userId)).limit(1);
  // A refusal, answered as one: the processor reads any non-OK status as "gate unavailable" and falls back to its
  // own mode, which outside enforce would store the image unscanned.
  if (!user) return Response.json({ accept: false });

  // Read under the cap: a chunked body has no Content-Length to refuse up front.
  const bytes = await readBytesWithCap(request, MAX_AVATAR_BYTES);
  if (bytes === null) return Response.json({ error: 'Too large' }, { status: 413 });
  if (bytes.length === 0) return Response.json({ error: 'No bytes' }, { status: 400 });

  const result = await gateAvatarBytes(bytes, user.id);
  return Response.json({ accept: result.accept });
}
