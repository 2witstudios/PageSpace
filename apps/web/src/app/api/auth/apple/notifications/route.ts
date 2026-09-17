import { verifyAppleServerNotification, handleAppleServerNotification } from '@pagespace/lib/auth/apple/apple-notifications';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { getClientIP } from '@/lib/auth';

/** A notification JWT is a few hundred bytes; anything this size is not Apple. */
const MAX_PAYLOAD_LENGTH = 8192;

/**
 * POST /api/auth/apple/notifications
 *
 * Sign in with Apple server-to-server notification endpoint (TN3194). Register
 * it for the primary App ID in the Apple developer portal. No session: the
 * request authenticates by Apple's signature on the JWT, verified against
 * Apple's JWKS before anything is acted on. The per-IP limit sits in front of
 * verification because an unknown `kid` makes verification refetch the JWKS.
 *
 * 200 for every verified notification (including events PageSpace ignores), so
 * Apple does not retry them; 400 for anything unverifiable; 500 when acting on a
 * verified notification failed, so Apple retries it.
 */
export async function POST(req: Request) {
  const clientIP = getClientIP(req);
  const rateLimit = await checkDistributedRateLimit(`apple:notifications:ip:${clientIP}`, DISTRIBUTED_RATE_LIMITS.API);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter ?? 60) } },
    );
  }

  const body = (await req.json().catch(() => null)) as { payload?: unknown } | null;
  const payload = body?.payload;
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_PAYLOAD_LENGTH) {
    return Response.json({ error: 'Invalid notification' }, { status: 400 });
  }

  const verification = await verifyAppleServerNotification(payload);
  if (!verification.ok) {
    loggers.auth.warn('Rejected Sign in with Apple notification', { reason: verification.reason });
    auditRequest(req, {
      eventType: 'security.suspicious.activity',
      riskScore: 0.5,
      details: { reason: 'apple_notification_unverified', verificationFailure: verification.reason },
    });
    return Response.json({ error: 'Invalid notification' }, { status: 400 });
  }

  try {
    const outcome = await handleAppleServerNotification(verification.event);
    if (outcome.action === 'sessions_ended') {
      auditRequest(req, {
        eventType: 'auth.session.revoked',
        userId: outcome.userId,
        resourceType: 'user',
        resourceId: outcome.userId,
        details: { reason: `apple_${verification.event.type}`, source: 'apple_server_notification' },
      });
    } else {
      auditRequest(req, {
        eventType: 'data.read',
        details: { operation: 'apple_server_notification', eventType: verification.event.type, action: outcome.action },
      });
    }
    return Response.json({ received: true });
  } catch (error) {
    loggers.auth.error('Failed to handle Sign in with Apple notification', error as Error, { eventType: verification.event.type });
    return Response.json({ error: 'Notification handling failed' }, { status: 500 });
  }
}
