import { secureCompare } from '@pagespace/lib/auth/secure-compare';

/**
 * Service-to-service auth for routes the admin app proxies to: the shared
 * `SERVICE_API_SECRET` in `x-service-secret`, plus the acting admin's ID in
 * `x-service-user-id`.
 *
 * This is the same check `GET /api/admin/global-prompt` makes for its admin
 * proxy (apps/admin/src/app/api/admin/global-prompt/route.ts is the caller):
 * fail closed when the secret is unset or empty, and compare in constant time —
 * the secret is unhashed and shared, so a plain `!==` would leak it a byte at a
 * time under timing analysis.
 */
export type ServiceSecretAuth = { ok: true; userId: string } | { ok: false; response: Response };

export function authenticateServiceSecret(request: Request): ServiceSecretAuth {
  const provided = request.headers.get('x-service-secret');
  const expected = process.env.SERVICE_API_SECRET;
  if (provided === null || !expected || !secureCompare(provided, expected)) {
    return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  const userId = request.headers.get('x-service-user-id');
  if (!userId) {
    return { ok: false, response: Response.json({ error: 'Missing user context' }, { status: 400 }) };
  }
  return { ok: true, userId };
}
