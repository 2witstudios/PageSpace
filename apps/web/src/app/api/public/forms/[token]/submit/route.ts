/**
 * Public Canvas-form submission endpoint.
 * No authentication required — zero-trust hardened:
 * - Origin/Referer are NEVER the authorization decision (middleware only logs
 *   them for this route; valid callers are arbitrary published-site hosts).
 * - The ONLY thing that authorizes a write is the token hash lookup below.
 * - Rate limited per-IP AND per-token-prefix (10/min each).
 * - Payload size cap: 8KB.
 * - Honeypot-triggered submissions get a 200 with no row appended, and no
 *   signal to the caller that anything was detected.
 * - Unknown and paused/archived tokens return the identical 404 — no oracle.
 */
import { getTokenPrefix, hashToken } from '@pagespace/lib/auth/token-utils';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { buildSubmissionSchema } from '@pagespace/lib/forms/submission-schema';
import { isHoneypotTriggered, HONEYPOT_FIELD_NAME } from '@pagespace/lib/forms/honeypot';
import { getClientIP } from '@/lib/auth/auth-helpers';
import { lookupActiveFormTarget, appendFormSubmission } from '@/services/api/form-target-service';
import { loggers } from '@pagespace/lib/logging/logger-config';

const MAX_PAYLOAD_BYTES = 8 * 1024;

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;

    // 1. Size cap — before touching rate limits or the DB.
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return Response.json({ error: 'Payload too large' }, { status: 413 });
    }

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, 'utf-8') > MAX_PAYLOAD_BYTES) {
      return Response.json({ error: 'Payload too large' }, { status: 413 });
    }

    // 2. Rate limit — per IP, and per token prefix (a pure function of the raw
    // token, no DB lookup needed) so one leaked token can't be hammered from
    // many IPs to bypass the IP-keyed limit.
    const ip = getClientIP(request);
    const [ipLimit, tokenLimit] = await Promise.all([
      checkDistributedRateLimit(`form:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.FORM_SUBMISSION),
      checkDistributedRateLimit(`form:token:${getTokenPrefix(token)}`, DISTRIBUTED_RATE_LIMITS.FORM_SUBMISSION),
    ]);

    if (!ipLimit.allowed || !tokenLimit.allowed) {
      const retryAfter = Math.max(ipLimit.retryAfter ?? 0, tokenLimit.retryAfter ?? 0) || 60;
      loggers.api.warn('Form submission rate limit exceeded', { ip });
      return Response.json(
        { error: 'Too many submissions. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }

    // 3. Token authorization — the ONLY gate that authorizes the write.
    // Unknown and paused/archived tokens are treated identically: 404, no
    // distinguishable signal either way.
    const formTarget = await lookupActiveFormTarget(token);
    if (!formTarget) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // 4. Parse JSON.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // 5. Honeypot — silently drop, never reveal detection to the caller.
    const payload = parsed as Record<string, unknown>;
    if (isHoneypotTriggered(payload)) {
      return Response.json({ success: true }, { status: 200 });
    }

    // 6. Schema validation against this form's own stored field schema.
    const { [HONEYPOT_FIELD_NAME]: _honeypot, ...submittedFields } = payload;
    const schema = buildSubmissionSchema(formTarget.fields);
    const validation = schema.safeParse(submittedFields);
    if (!validation.success) {
      return Response.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    // 7. Row append — the only write in this handler.
    await appendFormSubmission({
      formTargetId: formTarget.id,
      values: validation.data,
      submitterIpHash: hashToken(ip),
    });

    return Response.json({ success: true }, { status: 200 });
  } catch (error) {
    loggers.api.error('Public form submission error', error as Error);
    return Response.json(
      { error: 'An unexpected error occurred. Please try again later.' },
      { status: 500 }
    );
  }
}
