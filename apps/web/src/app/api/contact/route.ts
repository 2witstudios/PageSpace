/**
 * Public contact form endpoint
 * No authentication required — hardened with zero-trust controls:
 * - Rate limited: 10 requests/minute per IP
 * - Payload size cap: 5KB
 * - Strict schema validation
 */

import { z } from 'zod/v4';
import { db } from '@pagespace/db/db'
import { contactSubmissions } from '@pagespace/db/schema/contact';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { getClientIP } from '@/lib/auth/auth-helpers';

const MAX_PAYLOAD_BYTES = 5 * 1024; // 5KB

const contactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Valid email is required').max(254),
  subject: z.string().min(1, 'Subject is required').max(200),
  message: z.string().min(10, 'Message must be at least 10 characters').max(2000),
});

export async function POST(request: Request) {
  try {
    const ip = getClientIP(request);

    // Rate limit by IP
    const rateLimitResult = await checkDistributedRateLimit(
      `contact:ip:${ip}`,
      DISTRIBUTED_RATE_LIMITS.CONTACT_FORM
    );

    if (!rateLimitResult.allowed) {
      loggers.api.warn('Contact form rate limit exceeded', { ip });
      return Response.json(
        { error: 'Too many submissions. Please try again later.' },
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
      return Response.json(
        { error: 'Invalid JSON' },
        { status: 400 }
      );
    }

    // Schema validation
    const validation = contactSchema.safeParse(parsed);
    if (!validation.success) {
      return Response.json(
        {
          error: 'Validation failed',
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { name, email, subject, message } = validation.data;

    // Store in database
    await db.insert(contactSubmissions).values({
      name: name.trim(),
      email: email.trim(),
      subject: subject.trim(),
      message: message.trim(),
    });

    const trimmedEmail = email.trim();
    const maskedEmail = trimmedEmail.replace(/(.{2}).*(@.*)/, '$1***$2');
    loggers.api.info('Contact submission received', {
      ip,
      email: maskedEmail,
    });

    return Response.json(
      { message: 'Message sent successfully. We\'ll get back to you soon!' },
      { status: 201 }
    );
  } catch (error) {
    loggers.api.error('Contact form error', error as Error);
    return Response.json(
      { error: 'An unexpected error occurred. Please try again later.' },
      { status: 500 }
    );
  }
}
