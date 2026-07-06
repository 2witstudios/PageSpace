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
 * - CORS is wide open (Allow-Origin: *): the caller's origin is unbounded by
 *   design (arbitrary published-site hosts/custom domains, see middleware.ts)
 *   and carries no authorization weight — the token hash lookup is the only
 *   gate, so there's nothing an origin restriction would protect here.
 */
import { getTokenPrefix, hashToken } from '@pagespace/lib/auth/token-utils';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { buildSubmissionSchema } from '@pagespace/lib/forms/submission-schema';
import { isHoneypotTriggered, HONEYPOT_FIELD_NAME } from '@pagespace/lib/forms/honeypot';
import { getClientIP } from '@/lib/auth/auth-helpers';
import { lookupActiveFormTarget, appendFormSubmission } from '@/services/api/form-target-service';
import { loggers } from '@pagespace/lib/logging/logger-config';

const MAX_PAYLOAD_BYTES = 8 * 1024;

// Content-Type: application/json is not CORS-safelisted, so a cross-origin
// fetch() (the normal case — the submitting page lives on a different origin
// than this API) triggers a preflight OPTIONS request first. Every response,
// preflight and actual, must carry matching CORS headers or the browser
// blocks the request before the server logic below ever runs.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsJson(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: { ...CORS_HEADERS, ...(init?.headers ?? {}) },
  });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Reads a request body as text, aborting as soon as the byte cap is exceeded
 * instead of buffering the whole stream first — bounds memory use for a
 * caller that omits Content-Length (or uses chunked transfer-encoding).
 * Returns null if the cap is exceeded.
 */
async function readBodyWithCap(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;

    // 1. Size cap — before touching rate limits or the DB. Enforced while
    // streaming, not after a full read: a caller that omits Content-Length
    // (or uses chunked transfer-encoding) would otherwise force full
    // in-memory buffering of an arbitrarily large body before the declared-
    // length check below ever runs.
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return corsJson({ error: 'Payload too large' }, { status: 413 });
    }

    const rawBody = await readBodyWithCap(request, MAX_PAYLOAD_BYTES);
    if (rawBody === null) {
      return corsJson({ error: 'Payload too large' }, { status: 413 });
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
      // Hashed, not raw — consistent with the hashed IP persisted on a
      // successful submission below; app logs commonly have broader
      // retention/access than the database.
      loggers.api.warn('Form submission rate limit exceeded', { ipHash: hashToken(ip) });
      return corsJson(
        { error: 'Too many submissions. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }

    // 3. Token authorization — the ONLY gate that authorizes the write.
    // Unknown and paused/archived tokens are treated identically: 404, no
    // distinguishable signal either way.
    const formTarget = await lookupActiveFormTarget(token);
    if (!formTarget) {
      return corsJson({ error: 'Not found' }, { status: 404 });
    }

    // 4. Parse JSON.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return corsJson({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return corsJson({ error: 'Invalid JSON' }, { status: 400 });
    }

    // 5. Honeypot — silently drop, never reveal detection to the caller.
    const payload = parsed as Record<string, unknown>;
    if (isHoneypotTriggered(payload)) {
      return corsJson({ success: true }, { status: 200 });
    }

    // 6. Schema validation against this form's own stored field schema.
    const { [HONEYPOT_FIELD_NAME]: _honeypot, ...submittedFields } = payload;
    const schema = buildSubmissionSchema(formTarget.fields);
    const validation = schema.safeParse(submittedFields);
    if (!validation.success) {
      return corsJson(
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

    return corsJson({ success: true }, { status: 200 });
  } catch (error) {
    loggers.api.error('Public form submission error', error as Error);
    return corsJson(
      { error: 'An unexpected error occurred. Please try again later.' },
      { status: 500 }
    );
  }
}
