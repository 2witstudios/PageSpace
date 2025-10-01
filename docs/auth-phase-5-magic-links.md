# Phase 5: Magic Links

**Timeline:** Week 8
**Risk Level:** VERY LOW
**Dependencies:** Uses existing verification tokens table

---

## Overview

This phase implements magic link authentication - passwordless email login. Users receive a one-time link via email that logs them in directly without entering a password.

**Features:**
- Request magic link via email
- One-click login from email
- Rate limiting to prevent abuse
- 15-minute expiration
- Beautiful email template
- Works with existing users only (not signup)

---

## Week 8: Passwordless Email Login

### 8.1. Create Magic Link Email Template

**File:** `/packages/lib/src/email-templates/MagicLinkEmail.tsx`

```tsx
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Section,
  Text,
} from '@react-email/components';

interface MagicLinkEmailProps {
  userName: string;
  magicUrl: string;
}

export function MagicLinkEmail({ userName, magicUrl }: MagicLinkEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Heading style={h1}>Sign in to PageSpace</Heading>
          </Section>
          <Section style={content}>
            <Text style={paragraph}>Hi {userName},</Text>
            <Text style={paragraph}>
              Click the button below to sign in to your PageSpace account. This link will expire in 15 minutes.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={magicUrl}>
                Sign In to PageSpace
              </Button>
            </Section>
            <Text style={hint}>
              Or copy and paste this link into your browser:
              <br />
              <Link href={magicUrl} style={link}>
                {magicUrl}
              </Link>
            </Text>
            <Text style={footer}>
              If you didn't request this link, you can safely ignore this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// Styles
const main = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  borderRadius: '8px',
  boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
};

const header = {
  padding: '32px 48px',
  backgroundColor: '#0070f3',
  borderRadius: '8px 8px 0 0',
};

const h1 = {
  color: '#ffffff',
  fontSize: '28px',
  fontWeight: 'bold',
  margin: '0',
  padding: '0',
  lineHeight: '1.4',
};

const content = {
  padding: '0 48px',
};

const paragraph = {
  fontSize: '16px',
  lineHeight: '26px',
  color: '#404040',
  margin: '16px 0',
};

const buttonContainer = {
  padding: '27px 0',
  textAlign: 'center' as const,
};

const button = {
  backgroundColor: '#0070f3',
  borderRadius: '6px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: 'bold',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '12px 40px',
};

const hint = {
  fontSize: '14px',
  lineHeight: '24px',
  color: '#666666',
  margin: '16px 0',
};

const link = {
  color: '#0070f3',
  textDecoration: 'underline',
  wordBreak: 'break-all' as const,
};

const footer = {
  fontSize: '12px',
  lineHeight: '20px',
  color: '#8898aa',
  marginTop: '30px',
  paddingTop: '30px',
  borderTop: '1px solid #dddddd',
};
```

### 8.2. Create Magic Link Request Endpoint

**File:** `/apps/web/src/app/api/auth/magic-link/request/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, users, eq } from '@pagespace/db';
import { createVerificationToken } from '@pagespace/lib/verification-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { MagicLinkEmail } from '@pagespace/lib/email-templates/MagicLinkEmail';
import { checkRateLimit } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

const requestSchema = z.object({
  email: z.email(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validation = requestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { errors: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { email } = validation.data;

    const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] ||
                     request.headers.get('x-real-ip') ||
                     'unknown';

    // Rate limiting
    const emailRateLimit = checkRateLimit(`magic-link:${email}`, {
      maxAttempts: 3,
      windowMs: 60 * 60 * 1000, // 1 hour
      blockDurationMs: 60 * 60 * 1000,
    });

    const ipRateLimit = checkRateLimit(`magic-link-ip:${clientIP}`, {
      maxAttempts: 10,
      windowMs: 60 * 60 * 1000,
      blockDurationMs: 60 * 60 * 1000,
    });

    if (!emailRateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many magic link requests for this email. Please try again later.' },
        { status: 429 }
      );
    }

    if (!ipRateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many magic link requests. Please try again later.' },
        { status: 429 }
      );
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (user) {
      const magicToken = await createVerificationToken({
        userId: user.id,
        type: 'magic_link',
        expiresInMinutes: 15,
      });

      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
      const magicUrl = `${baseUrl}/auth/verify-magic-link?token=${magicToken}`;

      await sendEmail({
        to: email,
        subject: 'Sign in to PageSpace',
        react: <MagicLinkEmail userName={user.name} magicUrl={magicUrl} />,
      });

      loggers.auth.info('Magic link sent', { userId: user.id, email });
    } else {
      loggers.auth.warn('Magic link requested for non-existent user', { email });
    }

    // Always return success to prevent email enumeration
    return NextResponse.json({
      message: 'If that email exists, a magic link has been sent.',
    });
  } catch (error) {
    loggers.auth.error('Magic link request error', error as Error);
    return NextResponse.json(
      { error: 'Failed to send magic link' },
      { status: 500 }
    );
  }
}
```

### 8.3. Create Magic Link Verification Endpoint

**File:** `/apps/web/src/app/api/auth/verify-magic-link/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@pagespace/lib/verification-utils';
import { db, users, refreshTokens, eq } from '@pagespace/db';
import { generateAccessToken, generateRefreshToken } from '@pagespace/lib/server';
import { serialize } from 'cookie';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    if (!token) {
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
      return NextResponse.redirect(new URL('/auth/signin?error=invalid_token', baseUrl));
    }

    const userId = await verifyToken(token, 'magic_link');

    if (!userId) {
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
      return NextResponse.redirect(new URL('/auth/signin?error=expired_token', baseUrl));
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
      return NextResponse.redirect(new URL('/auth/signin?error=user_not_found', baseUrl));
    }

    const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] ||
                     request.headers.get('x-real-ip') ||
                     'unknown';

    // Generate JWT tokens
    const accessToken = await generateAccessToken(user.id, user.tokenVersion, user.role);
    const refreshToken = await generateRefreshToken(user.id, user.tokenVersion, user.role);

    await db.insert(refreshTokens).values({
      id: createId(),
      token: refreshToken,
      userId: user.id,
      device: request.headers.get('user-agent'),
      ip: clientIP,
    });

    logAuthEvent('login', user.id, user.email, clientIP, 'Magic Link');
    trackAuthEvent(user.id, 'magic_link_login', {
      email: user.email,
      ip: clientIP,
      userAgent: request.headers.get('user-agent'),
    });

    const isProduction = process.env.NODE_ENV === 'production';
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
    const redirectUrl = new URL('/dashboard', baseUrl);
    redirectUrl.searchParams.set('auth', 'success');

    const accessTokenCookie = serialize('accessToken', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: 15 * 60,
      ...(isProduction && { domain: process.env.COOKIE_DOMAIN }),
    });

    const refreshTokenCookie = serialize('refreshToken', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
      ...(isProduction && { domain: process.env.COOKIE_DOMAIN }),
    });

    const headers = new Headers();
    headers.append('Set-Cookie', accessTokenCookie);
    headers.append('Set-Cookie', refreshTokenCookie);

    return NextResponse.redirect(redirectUrl, { headers });
  } catch (error) {
    loggers.auth.error('Magic link verification error', error as Error);
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
    return NextResponse.redirect(new URL('/auth/signin?error=verification_failed', baseUrl));
  }
}
```

---

## Frontend Integration

### Update Sign-In Page

Add magic link option:

```tsx
<div className="mt-4">
  <div className="relative">
    <div className="absolute inset-0 flex items-center">
      <span className="w-full border-t" />
    </div>
    <div className="relative flex justify-center text-xs uppercase">
      <span className="bg-background px-2 text-muted-foreground">
        Or continue with
      </span>
    </div>
  </div>

  <Button
    variant="outline"
    className="w-full mt-4"
    onClick={handleMagicLinkRequest}
    disabled={isLoading}
  >
    <MailIcon className="mr-2 h-4 w-4" />
    Send magic link
  </Button>
</div>
```

### Magic Link Request Handler

```typescript
const handleMagicLinkRequest = async () => {
  setIsLoading(true);
  try {
    const response = await fetch('/api/auth/magic-link/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (response.ok) {
      toast.success('Check your email for a magic link!');
    } else {
      const error = await response.json();
      toast.error(error.error || 'Failed to send magic link');
    }
  } catch (error) {
    toast.error('An error occurred');
  } finally {
    setIsLoading(false);
  }
};
```

---

## Testing Checklist

- [ ] Magic link request sends email
- [ ] Magic link email contains correct link
- [ ] Magic link login succeeds
- [ ] Magic link expires after 15 minutes
- [ ] Used magic link cannot be reused
- [ ] Rate limiting works (3 per hour per email)
- [ ] IP rate limiting works (10 per hour)
- [ ] Email enumeration prevention works
- [ ] Error handling for invalid/expired tokens
- [ ] Redirect to dashboard after login
- [ ] Login event logged correctly
- [ ] Works with existing users only

---

## Security Considerations

1. **Token Security:**
   - 15-minute expiration (shorter than email verification)
   - Cryptographically secure tokens (32 bytes)
   - Single-use tokens (marked as used)

2. **Rate Limiting:**
   - Per-email: 3 requests per hour
   - Per-IP: 10 requests per hour
   - Prevents spam and abuse

3. **Email Enumeration Prevention:**
   - Always return same response
   - Don't reveal if user exists
   - Log attempts for monitoring

4. **Login Only:**
   - Magic links only work for existing users
   - Cannot be used for signup
   - Prevents account creation spam

---

## User Experience

1. **Clear Messaging:**
   - "Check your email" success message
   - Email subject: "Sign in to PageSpace"
   - Clear expiration time (15 minutes)

2. **Error Handling:**
   - Expired link: "This link has expired. Request a new one."
   - Invalid link: "This link is invalid. Request a new one."
   - Used link: "This link has already been used. Request a new one."

3. **Convenience:**
   - One-click login from email
   - No password required
   - No additional verification steps

---

## Next Phase

Once Phase 5 is complete and tested, proceed to:
**Phase 6: Security Hardening & Polish** - See `docs/auth-phase-6-security-polish.md`
