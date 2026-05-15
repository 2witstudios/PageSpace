import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { waitlistEntries } from '@pagespace/db/schema/waitlist';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { getClientIP } from '@/lib/auth';
import { isUserLimitEnabled } from '@/lib/user-limit';

const waitlistSchema = z.object({
  email: z.email({ message: 'Please enter a valid email address' }),
  name: z.string().min(1).max(255).optional(),
});

export async function POST(req: Request) {
  try {
    // Only accept waitlist submissions when the user limit feature is enabled
    if (!isUserLimitEnabled()) {
      return Response.json({ message: 'Waitlist is not active.' }, { status: 404 });
    }

    const clientIP = getClientIP(req);

    const ipRateLimit = await checkDistributedRateLimit(
      `waitlist:ip:${clientIP}`,
      DISTRIBUTED_RATE_LIMITS.MAGIC_LINK,
    );

    if (!ipRateLimit.allowed) {
      return Response.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(ipRateLimit.retryAfter || 900) },
        },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const validation = waitlistSchema.safeParse(body);
    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { email, name } = validation.data;
    const normalizedEmail = email.toLowerCase().trim();

    await db
      .insert(waitlistEntries)
      .values({ email: normalizedEmail, ...(name && { name: name.trim() }) })
      .onConflictDoNothing({ target: waitlistEntries.email });

    // Always return success — prevents email enumeration
    return Response.json({ message: 'You\'re on the list.' });
  } catch (error) {
    console.error('Waitlist submission error', error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
