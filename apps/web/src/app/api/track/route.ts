/**
 * Simple tracking endpoint for client-side events
 * Fire-and-forget, always returns success for valid requests
 *
 * Zero-trust policy:
 * - Rate limited: 100 requests/minute per IP
 * - Payload size cap: 10KB
 * - Schema validation: only known event types and fields accepted
 */

import { z } from 'zod/v4';
import { trackActivity, trackFeature, trackError } from '@pagespace/lib/monitoring/activity-tracker';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getClientIP } from '@/lib/auth/auth-helpers';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

const MAX_PAYLOAD_BYTES = 10 * 1024; // 10KB

const VALID_EVENTS = [
  'page_view',
  'feature_used',
  'user_action',
  'search',
  'click',
  'client_error',
  'timing',
] as const;

const trackingSchema = z.object({
  event: z.enum(VALID_EVENTS),
  data: z.object({
    feature: z.string().max(200).optional(),
    action: z.string().max(200).optional(),
    resource: z.string().max(200).optional(),
    resourceId: z.string().max(200).optional(),
    type: z.string().max(200).optional(),
    message: z.string().max(2000).optional(),
    duration: z.number().optional(),
    path: z.string().max(2000).optional(),
    label: z.string().max(500).optional(),
    value: z.union([z.string().max(500), z.number()]).optional(),
  }).optional().default({}),
});

export async function POST(request: Request) {
  try {
    const ip = getClientIP(request);

    // Rate limit by IP
    const rateLimitResult = await checkDistributedRateLimit(
      `track:ip:${ip}`,
      DISTRIBUTED_RATE_LIMITS.TRACKING
    );

    if (!rateLimitResult.allowed) {
      return Response.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: { 'Retry-After': String(rateLimitResult.retryAfter || 60) },
        }
      );
    }

    // Check payload size via Content-Length header
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return Response.json(
        { error: 'Payload too large' },
        { status: 413 }
      );
    }

    // Read body as text first to verify actual byte size
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, 'utf-8') > MAX_PAYLOAD_BYTES) {
      return Response.json(
        { error: 'Payload too large' },
        { status: 413 }
      );
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return Response.json({ ok: true });
    }

    // Schema validation
    const validation = trackingSchema.safeParse(parsed);
    if (!validation.success) {
      return Response.json(
        { error: 'Invalid tracking payload' },
        { status: 400 }
      );
    }

    const { event, data } = validation.data;

    // Try to get user ID but don't block if auth fails
    let userId: string | undefined;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (!isAuthError(auth)) {
      userId = auth.userId;
    }

    const userAgent = request.headers.get('user-agent') || 'unknown';

    // ip and userAgent are passed as top-level fields to logActivity where they
    // land in dedicated PII columns excluded from the hash chain. Keeping them
    // out of enrichedData prevents them from entering the hashed metadata JSONB.
    const enrichedData = {
      ...data,
      timestamp: new Date().toISOString(),
    };

    // Route different event types
    switch (event) {
      case 'page_view':
        trackActivity(userId, 'page_view', {
          metadata: enrichedData,
          ip,
          userAgent,
        });
        break;

      case 'feature_used':
        trackFeature(userId, data.feature || 'unknown', enrichedData);
        break;

      case 'user_action':
        trackActivity(userId, data.action || event, {
          resource: data.resource,
          resourceId: data.resourceId,
          metadata: enrichedData,
          ip,
          userAgent,
        });
        break;

      case 'search':
        trackActivity(userId, 'search', {
          metadata: enrichedData,
          ip,
          userAgent,
        });
        break;

      case 'click':
        trackActivity(userId, 'ui_click', {
          metadata: enrichedData,
          ip,
          userAgent,
        });
        break;

      case 'client_error':
        trackError(userId, data.type || 'client', data.message || 'Unknown error', enrichedData);
        break;

      case 'timing':
        if (data.duration && data.duration > 3000) {
          trackActivity(userId, 'slow_operation', {
            metadata: enrichedData,
            ip,
            userAgent,
          });
        }
        break;
    }

    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: true });
  }
}

// Support beacon API (sends as text/plain)
export async function PUT(request: Request) {
  try {
    const text = await request.text();

    // Check payload size
    if (text.length > MAX_PAYLOAD_BYTES) {
      return Response.json(
        { error: 'Payload too large' },
        { status: 413 }
      );
    }

    const body = JSON.parse(text);

    const newRequest = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(body),
    });

    return POST(newRequest);
  } catch {
    return Response.json({ ok: true });
  }
}
