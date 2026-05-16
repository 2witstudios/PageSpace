import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users, verificationTokens } from '@pagespace/db/schema/auth';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { MagicLinkEmail } from '@pagespace/lib/email-templates/MagicLinkEmail';
import { loggers } from '@pagespace/lib/logging/logger-config';

const schema = z.object({
  email: z.email({ message: 'Please enter a valid email address' }),
});

const MAGIC_LINK_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

const GENERIC_SUCCESS = { message: 'If an admin account exists with this email, we have sent a sign-in link.' };

export async function POST(req: Request) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const email = parsed.data.email.toLowerCase().trim();

    // Look up user — must exist and be an admin
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true, role: true, suspendedAt: true },
    });

    // Return generic success regardless of outcome to prevent enumeration
    if (!user || user.role !== 'admin' || user.suspendedAt) {
      loggers.auth.info('Admin magic link request for non-admin or unknown email (suppressed)', { email: email.slice(0, 3) + '...' });
      return Response.json(GENERIC_SUCCESS);
    }

    // Create verification token
    const { token, hash, tokenPrefix } = generateToken('ps_magic');
    const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);

    await db.insert(verificationTokens).values({
      userId: user.id,
      tokenHash: hash,
      tokenPrefix,
      type: 'magic_link',
      expiresAt,
    });

    const adminUrl = process.env.ADMIN_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3005';
    const magicLinkUrl = `${adminUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;

    await sendEmail({
      to: email,
      subject: 'Sign in to PageSpace Admin',
      react: MagicLinkEmail({ magicLinkUrl }),
    });

    loggers.auth.info('Admin magic link sent', { userId: user.id });
    return Response.json(GENERIC_SUCCESS);
  } catch (error) {
    loggers.auth.error('Admin magic link send error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
