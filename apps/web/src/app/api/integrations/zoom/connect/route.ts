import { z } from 'zod/v4';
import crypto from 'crypto';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { authenticateRequestWithOptions, isAuthError, getClientIP } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const connectSchema = z.object({
  returnUrl: z.string().optional(),
});

export async function POST(req: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  try {
    if (!process.env.ZOOM_OAUTH_CLIENT_ID || !process.env.ZOOM_OAUTH_CLIENT_SECRET || !process.env.OAUTH_STATE_SECRET) {
      loggers.auth.error('Missing required Zoom OAuth environment variables');
      return Response.json({ error: 'OAuth not configured' }, { status: 500 });
    }

    const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    let body: unknown;
    try { body = await req.json(); } catch { body = {}; }
    const validation = connectSchema.safeParse(body);
    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const clientIP = getClientIP(req);
    const rateLimit = await checkDistributedRateLimit(
      `zoom:connect:user:${userId}`,
      DISTRIBUTED_RATE_LIMITS.LOGIN
    );
    if (!rateLimit.allowed) {
      return Response.json(
        { error: 'Too many connection attempts. Please try again later.', retryAfter: rateLimit.retryAfter },
        { status: 429 }
      );
    }

    const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
    const callbackUrl = `${baseUrl}/api/integrations/zoom/callback`;

    const stateData = { userId, returnUrl: validation.data.returnUrl ?? '/settings/integrations/zoom', timestamp: Date.now() };
    const statePayload = JSON.stringify(stateData);
    const signature = crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET!).update(statePayload).digest('hex');
    const stateParam = Buffer.from(JSON.stringify({ data: stateData, sig: signature })).toString('base64');

    const params = new URLSearchParams({
      client_id: process.env.ZOOM_OAUTH_CLIENT_ID!,
      redirect_uri: callbackUrl,
      response_type: 'code',
      state: stateParam,
    });

    const oauthUrl = `https://zoom.us/oauth/authorize?${params.toString()}`;

    loggers.auth.info('Zoom OAuth initiated', { userId, clientIP });
    auditRequest(req, { eventType: 'data.write', userId, resourceType: 'zoom_connection', resourceId: 'self', details: { operation: 'oauth_initiated' } });

    return Response.json({ url: oauthUrl });
  } catch (error) {
    loggers.auth.error('Zoom connect error', error as Error);
    return Response.json({ error: 'An unexpected error occurred' }, { status: 500 });
  }
}
