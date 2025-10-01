# Phase 1: Email Verification & Password Reset

**Timeline:** Week 1-2
**Risk Level:** LOW
**Dependencies:** Resend, React Email

---

## Overview

This phase implements email verification and password reset functionality using Resend for email delivery and React Email for type-safe email templates.

**Features:**
- Email verification during signup
- Password reset request flow
- Password reset verification with strong password requirements
- Rate limiting on all email endpoints
- Beautiful, responsive email templates

---

## Week 1: Email Verification System

### 1.1. Install Dependencies

```bash
pnpm add resend react-email @react-email/components
```

**Why Resend?**
- Modern API service built for Next.js developers
- React Email templates (type-safe, component-based)
- 5-minute setup (no SMTP configuration)
- Excellent deliverability (automatic SPF/DKIM/DMARC)
- Dashboard with real-time analytics and delivery tracking
- Free tier: 100 emails/day (3,000/month) - perfect for early stage
- Webhooks for bounce/complaint handling

### 1.2. Create Verification Tokens Table

**File:** `/packages/db/src/schema/auth.ts`

Add new table schema:

```typescript
export const verificationTokens = pgTable('verification_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  type: text('type').notNull(), // 'email_verification' | 'password_reset' | 'magic_link'
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  usedAt: timestamp('usedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('verification_tokens_user_id_idx').on(table.userId),
    tokenIdx: index('verification_tokens_token_idx').on(table.token),
    typeIdx: index('verification_tokens_type_idx').on(table.type),
  };
});

export const verificationTokensRelations = relations(verificationTokens, ({ one }) => ({
  user: one(users, {
    fields: [verificationTokens.userId],
    references: [users.id],
  }),
}));
```

**Migration:**
```bash
pnpm db:generate
# Review migration in packages/db/drizzle/
pnpm db:migrate
```

### 1.3. Create Email Service Module

**File:** `/packages/lib/src/services/email-service.ts`

```typescript
import { Resend } from 'resend';
import { checkRateLimit } from '../rate-limit-utils';

function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || 'PageSpace <onboarding@resend.dev>';

  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is required');
  }

  return { apiKey, from };
}

const resend = new Resend(getResendConfig().apiKey);

export interface SendEmailOptions {
  to: string;
  subject: string;
  react: React.ReactElement;
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const config = getResendConfig();

  // Rate limit email sending (3 per hour per recipient)
  const rateLimit = checkRateLimit(`email:${options.to}`, {
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockDurationMs: 60 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    throw new Error(`Too many emails sent to ${options.to}. Please try again later.`);
  }

  const { data, error } = await resend.emails.send({
    from: config.from,
    to: options.to,
    subject: options.subject,
    react: options.react,
  });

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }

  return data;
}
```

### 1.3.1. Create React Email Templates

**File:** `/packages/lib/src/email-templates/VerificationEmail.tsx`

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

interface VerificationEmailProps {
  userName: string;
  verificationUrl: string;
}

export function VerificationEmail({ userName, verificationUrl }: VerificationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Heading style={h1}>Welcome to PageSpace!</Heading>
          </Section>
          <Section style={content}>
            <Text style={paragraph}>Hi {userName},</Text>
            <Text style={paragraph}>
              Thanks for signing up! Please verify your email address to complete your account setup.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={verificationUrl}>
                Verify Email Address
              </Button>
            </Section>
            <Text style={hint}>
              Or copy and paste this link into your browser:
              <br />
              <Link href={verificationUrl} style={link}>
                {verificationUrl}
              </Link>
            </Text>
            <Text style={footer}>
              This link will expire in 24 hours. If you didn't create a PageSpace account, you can safely ignore this email.
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
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
};

const container = {
  margin: '0 auto',
  padding: '20px 0',
  maxWidth: '600px',
};

const header = {
  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  borderRadius: '10px 10px 0 0',
  padding: '30px',
  textAlign: 'center' as const,
};

const h1 = {
  color: '#ffffff',
  fontSize: '28px',
  fontWeight: '600',
  margin: '0',
};

const content = {
  backgroundColor: '#ffffff',
  borderRadius: '0 0 10px 10px',
  padding: '40px 30px',
};

const paragraph = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#333333',
};

const buttonContainer = {
  textAlign: 'center' as const,
  margin: '40px 0',
};

const button = {
  backgroundColor: '#667eea',
  borderRadius: '6px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '14px 40px',
};

const hint = {
  fontSize: '14px',
  color: '#666666',
  marginTop: '40px',
};

const link = {
  color: '#667eea',
  textDecoration: 'underline',
  wordBreak: 'break-all' as const,
};

const footer = {
  fontSize: '14px',
  color: '#666666',
  marginTop: '30px',
  paddingTop: '30px',
  borderTop: '1px solid #dddddd',
};
```

**File:** `/packages/lib/src/email-templates/PasswordResetEmail.tsx`

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

interface PasswordResetEmailProps {
  userName: string;
  resetUrl: string;
}

export function PasswordResetEmail({ userName, resetUrl }: PasswordResetEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Heading style={h1}>Password Reset</Heading>
          </Section>
          <Section style={content}>
            <Text style={paragraph}>Hi {userName},</Text>
            <Text style={paragraph}>
              We received a request to reset your password. Click the button below to choose a new password.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={resetUrl}>
                Reset Password
              </Button>
            </Section>
            <Text style={hint}>
              Or copy and paste this link into your browser:
              <br />
              <Link href={resetUrl} style={link}>
                {resetUrl}
              </Link>
            </Text>
            <Text style={footer}>
              This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// Styles (same gradient but different color scheme)
const main = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
};

const container = {
  margin: '0 auto',
  padding: '20px 0',
  maxWidth: '600px',
};

const header = {
  background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  borderRadius: '10px 10px 0 0',
  padding: '30px',
  textAlign: 'center' as const,
};

const h1 = {
  color: '#ffffff',
  fontSize: '28px',
  fontWeight: '600',
  margin: '0',
};

const content = {
  backgroundColor: '#ffffff',
  borderRadius: '0 0 10px 10px',
  padding: '40px 30px',
};

const paragraph = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#333333',
};

const buttonContainer = {
  textAlign: 'center' as const,
  margin: '40px 0',
};

const button = {
  backgroundColor: '#f5576c',
  borderRadius: '6px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '14px 40px',
};

const hint = {
  fontSize: '14px',
  color: '#666666',
  marginTop: '40px',
};

const link = {
  color: '#f5576c',
  textDecoration: 'underline',
  wordBreak: 'break-all' as const,
};

const footer = {
  fontSize: '14px',
  color: '#666666',
  marginTop: '30px',
  paddingTop: '30px',
  borderTop: '1px solid #dddddd',
};
```

### 1.4. Create Verification Utilities

**File:** `/packages/lib/src/verification-utils.ts`

```typescript
import { db, verificationTokens, users, eq } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { randomBytes } from 'crypto';

export type VerificationType = 'email_verification' | 'password_reset' | 'magic_link';

interface CreateTokenOptions {
  userId: string;
  type: VerificationType;
  expiresInMinutes?: number;
}

export async function createVerificationToken(options: CreateTokenOptions): Promise<string> {
  const { userId, type, expiresInMinutes = type === 'password_reset' ? 60 : 1440 } = options;

  // Generate cryptographically secure token
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

  // Clean up old unused tokens for this user and type
  await db
    .delete(verificationTokens)
    .where(
      eq(verificationTokens.userId, userId),
      eq(verificationTokens.type, type),
      eq(verificationTokens.usedAt, null)
    );

  // Create new token
  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    token,
    type,
    expiresAt,
  });

  return token;
}

export async function verifyToken(token: string, expectedType: VerificationType): Promise<string | null> {
  const record = await db.query.verificationTokens.findFirst({
    where: eq(verificationTokens.token, token),
  });

  if (!record) {
    return null; // Token not found
  }

  // Check if token has been used
  if (record.usedAt) {
    return null; // Token already used
  }

  // Check if token has expired
  if (record.expiresAt < new Date()) {
    return null; // Token expired
  }

  // Check token type matches
  if (record.type !== expectedType) {
    return null; // Wrong token type
  }

  // Mark token as used
  await db
    .update(verificationTokens)
    .set({ usedAt: new Date() })
    .where(eq(verificationTokens.id, record.id));

  return record.userId;
}

export async function markEmailVerified(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerified: new Date() })
    .where(eq(users.id, userId));
}
```

### 1.5. Update Signup Route

**File:** `/apps/web/src/app/api/auth/signup/route.ts`

Add after user creation (around line 118):

```typescript
// Send verification email (don't block signup)
try {
  const verificationToken = await createVerificationToken({
    userId: user.id,
    type: 'email_verification',
  });

  const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || 'http://localhost:3000';
  const verificationUrl = `${baseUrl}/auth/verify-email?token=${verificationToken}`;

  await sendEmail({
    to: email,
    subject: 'Verify your PageSpace email',
    react: <VerificationEmail userName={name} verificationUrl={verificationUrl} />,
  });

  loggers.auth.info('Verification email sent', { userId: user.id, email });
} catch (error) {
  // Don't fail signup if email fails
  loggers.auth.error('Failed to send verification email', error as Error, { userId: user.id });
}
```

### 1.6. Create Verification Endpoint

**File:** `/apps/web/src/app/api/auth/verify-email/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, markEmailVerified } from '@pagespace/lib/verification-utils';
import { loggers } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    if (!token) {
      return NextResponse.json({ error: 'Verification token is required' }, { status: 400 });
    }

    const userId = await verifyToken(token, 'email_verification');

    if (!userId) {
      return NextResponse.json(
        { error: 'Invalid or expired verification token' },
        { status: 400 }
      );
    }

    // Mark email as verified
    await markEmailVerified(userId);

    // Log verification
    loggers.auth.info('Email verified', { userId });
    trackAuthEvent(userId, 'email_verified', {});

    // Redirect to success page
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
    return NextResponse.redirect(new URL('/auth/email-verified', baseUrl));
  } catch (error) {
    loggers.auth.error('Email verification error', error as Error);
    return NextResponse.json({ error: 'Email verification failed' }, { status: 500 });
  }
}
```

---

## Week 2: Password Reset Flow

### 2.1. Create Password Reset Request Endpoint

**File:** `/apps/web/src/app/api/auth/password-reset/request/route.ts`

See original plan for full implementation. This endpoint:
- Validates email input
- Rate limits requests (per IP and per email)
- Finds user by email
- Generates password reset token
- Sends password reset email
- Returns same response regardless of whether user exists (prevents email enumeration)

### 2.2. Create Password Reset Verification Endpoint

**File:** `/apps/web/src/app/api/auth/password-reset/verify/route.ts`

See original plan for full implementation. This endpoint:
- Validates token and new password
- Enforces strong password requirements (12+ chars, uppercase, lowercase, number, special char)
- Hashes new password with bcrypt
- Updates password and increments tokenVersion (invalidates all sessions)
- Deletes all refresh tokens
- Logs password reset event
- Sends security notification email (optional)

### 2.3. Environment Variables

Add to `.env`:

```bash
# Resend Email Configuration
RESEND_API_KEY=re_xxxxxxxxxxxx
FROM_EMAIL=PageSpace <onboarding@yourdomain.com>
```

**Setup Instructions:**
1. Sign up at https://resend.com (free tier: 3,000 emails/month)
2. Create API key in dashboard
3. Add and verify your domain (or use Resend's test domain for development)
4. Copy API key to `.env`

---

## Testing Checklist

- [ ] Email delivery works (check Resend dashboard)
- [ ] Email verification completes successfully
- [ ] Expired verification tokens are rejected
- [ ] Used verification tokens are rejected
- [ ] Password reset request sends email
- [ ] Password reset with valid token works
- [ ] Password reset enforces strong password requirements
- [ ] Password reset invalidates all existing sessions
- [ ] Rate limiting works for email endpoints
- [ ] Email templates render correctly in Gmail, Outlook, Apple Mail
- [ ] Error handling works (invalid tokens, expired tokens, etc.)

---

## Security Considerations

1. **Token Security:**
   - Use `randomBytes(32)` for cryptographically secure tokens
   - Store tokens hashed in database (optional enhancement)
   - Expire tokens after appropriate time period
   - Mark tokens as used to prevent replay attacks

2. **Rate Limiting:**
   - Per-IP rate limiting prevents abuse
   - Per-email rate limiting prevents targeted attacks
   - Progressive delays for repeated violations

3. **Email Enumeration Prevention:**
   - Always return same response regardless of whether email exists
   - Log attempts for security monitoring

4. **Password Requirements:**
   - Minimum 12 characters
   - Must include uppercase, lowercase, number, and special character
   - Use bcrypt with cost factor 12

---

## Next Phase

Once Phase 1 is complete and tested, proceed to:
**Phase 2: WebAuthn/Passkeys** - See `docs/auth-phase-2-passkeys.md`
