/**
 * Public content report endpoint, behind the /report page. No account needed:
 * anyone who finds a published PageSpace site can report it.
 *
 * Hardened like the public contact form:
 * - Rate limited by IP (CONTENT_REPORT). The IP is used for the limit only and is
 *   never stored with the report or its case.
 * - Payload size cap: 32 KiB, read as a capped stream (a body with no Content-Length is cut off at the cap, not
 *   buffered). It covers the largest report the form allows: 2048 + 2000 + 254 characters at up to 4 bytes each.
 * - Strict schema; only URLs on our published hosts are accepted, with one
 *   neutral answer for everything else.
 * - Honeypot: a filled hidden field gets the normal 201 and nothing is filed.
 *
 * A report opens (or joins) a case for staff review and alerts the abuse inbox.
 * It never takes anything down or blocks it.
 */

import { isHoneypotTriggered } from '@pagespace/lib/forms/honeypot';
import { publicReportSchema } from '@pagespace/lib/content-safety/reports';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { getClientIP } from '@/lib/auth/auth-helpers';
import { readBodyWithCap } from '@/lib/http/read-body-with-cap';
import { fileReport } from '@/lib/content-safety/report-service';
import { REPORT_RECEIVED_MESSAGE, reportResponse } from '@/lib/content-safety/report-response';

const MAX_PAYLOAD_BYTES = 32 * 1024;

const tooLarge = () => Response.json({ error: 'Payload too large' }, { status: 413 });

export async function POST(request: Request) {
  try {
    const ip = getClientIP(request);
    const rateLimit = await checkDistributedRateLimit(`content-report:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.CONTENT_REPORT);
    if (!rateLimit.allowed) {
      return Response.json(
        { error: 'Too many reports. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter || 3600) } },
      );
    }

    if (parseInt(request.headers.get('content-length') || '0', 10) > MAX_PAYLOAD_BYTES) return tooLarge();
    const raw = await readBodyWithCap(request, MAX_PAYLOAD_BYTES);
    if (raw === null) return tooLarge();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // A bot gets the same answer as a person, so it learns nothing from the response.
    if (isHoneypotTriggered(parsed as Record<string, unknown>)) {
      return Response.json({ message: REPORT_RECEIVED_MESSAGE }, { status: 201 });
    }

    const validation = publicReportSchema.safeParse(parsed);
    if (!validation.success) {
      return Response.json({ error: 'Validation failed', details: validation.error.flatten().fieldErrors }, { status: 400 });
    }
    const { url, category, description, contactEmail } = validation.data;

    const outcome = await fileReport(request, null, {
      reporter: { kind: 'anonymous', ...(contactEmail ? { contactEmail } : {}) },
      target: { type: 'published_url', url },
      category,
      description,
    });
    return reportResponse(outcome);
  } catch (error) {
    loggers.api.error('Public content report error', error as Error);
    return Response.json({ error: 'An unexpected error occurred. Please try again later.' }, { status: 500 });
  }
}
