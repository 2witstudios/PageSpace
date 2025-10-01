# Phase 6: Security Hardening & Polish

**Timeline:** Week 9
**Risk Level:** LOW
**Dependencies:** None

---

## Overview

This final phase adds session management UI, security notifications, trusted devices, and comprehensive testing. It also includes documentation updates and deployment preparation.

**Features:**
- Session management UI (view and revoke sessions)
- Trusted device recognition (skip 2FA)
- Security event notifications
- Account recovery flow
- Security audit dashboard (admin)
- Comprehensive testing and documentation

---

## Week 9: Session Management, Monitoring & UX

### 9.1. Session Management

#### Create Sessions Table

**File:** `/packages/db/src/schema/auth.ts`

```typescript
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  refreshTokenId: text('refreshTokenId').references(() => refreshTokens.id, { onDelete: 'cascade' }),
  deviceName: text('deviceName'),
  deviceType: text('deviceType'), // 'mobile' | 'desktop' | 'tablet'
  browser: text('browser'),
  os: text('os'),
  ip: text('ip'),
  location: text('location'), // City, Country (from IP geolocation)
  isCurrent: boolean('isCurrent').default(false).notNull(),
  lastActivity: timestamp('lastActivity', { mode: 'date' }).defaultNow().notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdx: index('sessions_user_id_idx').on(table.userId),
    tokenIdx: index('sessions_refresh_token_id_idx').on(table.refreshTokenId),
  };
});

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
  refreshToken: one(refreshTokens, {
    fields: [sessions.refreshTokenId],
    references: [refreshTokens.id],
  }),
}));
```

**Migration:**
```bash
pnpm db:generate
pnpm db:migrate
```

#### List Sessions Endpoint

**File:** `/apps/web/src/app/api/auth/sessions/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, sessions, eq } from '@pagespace/db';

export async function GET(request: NextRequest) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userSessions = await db.query.sessions.findMany({
      where: eq(sessions.userId, user.id),
      orderBy: (sessions, { desc }) => [desc(sessions.lastActivity)],
    });

    return NextResponse.json({ sessions: userSessions });
  } catch (error) {
    console.error('List sessions error:', error);
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 });
  }
}
```

#### Revoke Session Endpoint

**File:** `/apps/web/src/app/api/auth/sessions/[id]/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, sessions, refreshTokens, eq, and } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;

    // Get session
    const session = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, id),
        eq(sessions.userId, user.id)
      ),
    });

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Delete refresh token and session
    await db.transaction(async (tx) => {
      if (session.refreshTokenId) {
        await tx.delete(refreshTokens).where(eq(refreshTokens.id, session.refreshTokenId));
      }
      await tx.delete(sessions).where(eq(sessions.id, id));
    });

    loggers.auth.info('Session revoked', { userId: user.id, sessionId: id });

    return NextResponse.json({ message: 'Session revoked successfully' });
  } catch (error) {
    console.error('Revoke session error:', error);
    return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 });
  }
}
```

#### Revoke All Sessions Endpoint

**File:** `/apps/web/src/app/api/auth/sessions/all/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, sessions, refreshTokens, users, eq, ne } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

export async function DELETE(request: NextRequest) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get current refresh token from cookie
    const currentRefreshToken = request.cookies.get('refreshToken')?.value;

    await db.transaction(async (tx) => {
      // Delete all refresh tokens except current
      if (currentRefreshToken) {
        await tx
          .delete(refreshTokens)
          .where(and(
            eq(refreshTokens.userId, user.id),
            ne(refreshTokens.token, currentRefreshToken)
          ));
      } else {
        await tx.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));
      }

      // Delete all sessions
      await tx.delete(sessions).where(eq(sessions.userId, user.id));

      // Increment tokenVersion (invalidates all access tokens)
      await tx
        .update(users)
        .set({ tokenVersion: db.raw('token_version + 1') })
        .where(eq(users.id, user.id));
    });

    loggers.auth.info('All sessions revoked', { userId: user.id });

    return NextResponse.json({ message: 'All sessions revoked successfully' });
  } catch (error) {
    console.error('Revoke all sessions error:', error);
    return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 });
  }
}
```

### 9.2. Trusted Devices

#### Create Trusted Devices Table

**File:** `/packages/db/src/schema/auth.ts`

```typescript
export const trustedDevices = pgTable('trusted_devices', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceFingerprint: text('deviceFingerprint').notNull(), // Hash of user agent + IP range
  deviceName: text('deviceName'),
  lastUsed: timestamp('lastUsed', { mode: 'date' }).defaultNow().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(), // 30 days from creation
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdx: index('trusted_devices_user_id_idx').on(table.userId),
    fingerprintIdx: index('trusted_devices_fingerprint_idx').on(table.deviceFingerprint),
  };
});

export const trustedDevicesRelations = relations(trustedDevices, ({ one }) => ({
  user: one(users, {
    fields: [trustedDevices.userId],
    references: [users.id],
  }),
}));
```

**Migration:**
```bash
pnpm db:generate
pnpm db:migrate
```

**Benefits:**
- Skip 2FA on trusted devices
- Security notifications when new device detected
- 30-day expiration

### 9.3. Security Event Notifications

#### Create Security Alert Email Template

**File:** `/packages/lib/src/email-templates/SecurityAlertEmail.tsx`

```tsx
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Section,
  Text,
} from '@react-email/components';

interface SecurityAlertEmailProps {
  userName: string;
  eventType: string;
  details: Record<string, string>;
}

export function SecurityAlertEmail({ userName, eventType, details }: SecurityAlertEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Heading style={h1}>Security Alert</Heading>
          </Section>
          <Section style={content}>
            <Text style={paragraph}>Hi {userName},</Text>
            <Text style={paragraph}>
              We detected <strong>{eventType}</strong> on your PageSpace account.
            </Text>
            <div style={detailsBox}>
              {Object.entries(details).map(([key, value]) => (
                <div key={key} style={detailRow}>
                  <span style={detailLabel}>{key}:</span>
                  <span style={detailValue}>{value}</span>
                </div>
              ))}
            </div>
            <Text style={paragraph}>
              If this wasn't you, please secure your account immediately by changing your password and reviewing your active sessions.
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
  background: 'linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%)',
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

const detailsBox = {
  backgroundColor: '#f8f9fa',
  borderRadius: '6px',
  padding: '20px',
  margin: '20px 0',
};

const detailRow = {
  marginBottom: '10px',
};

const detailLabel = {
  fontWeight: '600',
  marginRight: '10px',
  color: '#666666',
};

const detailValue = {
  color: '#333333',
};
```

**Send security alerts for:**
- New device login detected
- Password changed successfully
- 2FA enabled/disabled
- New passkey registered
- OAuth provider linked/unlinked
- All sessions revoked

### 9.4. Account Recovery Flow

For locked accounts or forgotten 2FA:

1. User initiates account recovery
2. Verify identity via:
   - Email verification
   - Security questions (optional)
   - Admin approval (for sensitive cases)
3. Reset 2FA or unlock account
4. Force password change
5. Invalidate all sessions

### 9.5. Security Audit Dashboard (Admin)

Create admin dashboard showing:
- Failed login attempts by IP
- Suspicious activity patterns
- Rate limit violations
- Recent security events
- User account status (locked, verified, 2FA enabled, etc.)

---

## Testing & Documentation

### 9.6. Testing Checklist

**Authentication Flows:**
- [ ] All auth flows tested (password, OAuth, passkeys, magic links, 2FA)
- [ ] Rate limiting tested (signup, login, password reset, magic links)
- [ ] Email delivery tested (verification, password reset, magic links, security alerts)
- [ ] Session management tested (list, revoke)
- [ ] Trusted devices tested (2FA skip)
- [ ] Error handling tested (expired tokens, invalid codes, etc.)
- [ ] Performance tested (auth latency <100ms)
- [ ] Security tested (OWASP checklist, CSRF, rate limiting, timing attacks)

**Cross-Browser Testing:**
- [ ] Chrome (desktop + mobile)
- [ ] Safari (macOS + iOS)
- [ ] Firefox
- [ ] Edge
- [ ] Passkeys work on all platforms

**Email Testing:**
- [ ] Gmail
- [ ] Outlook
- [ ] Apple Mail
- [ ] Mobile clients
- [ ] Dark mode compatibility

### 9.7. Documentation Updates

**API Documentation:**
- [ ] All new endpoints documented
- [ ] Request/response schemas
- [ ] Error codes and messages
- [ ] Rate limits

**User Guides:**
- [ ] How to enable 2FA
- [ ] How to register passkeys
- [ ] How to use magic links
- [ ] How to manage sessions
- [ ] Security best practices

**Admin Documentation:**
- [ ] Security dashboard usage
- [ ] Account recovery procedures
- [ ] Monitoring and alerting

**Developer Documentation:**
- [ ] Environment variables
- [ ] Email template customization
- [ ] Migration procedures
- [ ] Rollback procedures

---

## Deployment Preparation

### Pre-Deployment Checklist

- [ ] All environment variables configured
- [ ] Email service (Resend) configured and tested
- [ ] OAuth apps configured (Google, GitHub, Microsoft)
- [ ] Database migrations tested in staging
- [ ] Rate limiting thresholds tuned
- [ ] Email templates reviewed and approved
- [ ] Feature flags configured
- [ ] Monitoring and alerting set up
- [ ] Rollback procedures documented
- [ ] Team trained on new features

### Deployment Steps

1. Deploy to staging environment
2. Run full test suite
3. Test all auth flows end-to-end
4. Verify email delivery
5. Load test authentication endpoints
6. Review logs and metrics
7. Deploy to production (gradual rollout)
8. Monitor for issues
9. Collect user feedback

### Post-Deployment Monitoring

**Metrics to track:**
- Auth method distribution (password, OAuth, passkey, magic link)
- 2FA adoption rate
- Passkey adoption rate
- Email verification rate
- Failed auth attempts by IP
- Average login time
- Email delivery success rate
- Rate limit hits

---

## Success Criteria

### Technical Metrics

**Performance:**
- ✅ Email delivery time: <5 seconds
- ✅ Passkey registration: <2 seconds
- ✅ TOTP verification: <100ms
- ✅ Magic link generation: <1 second
- ✅ OAuth callback: <3 seconds

**Security:**
- ✅ Zero security vulnerabilities in new code
- ✅ All endpoints protected by rate limiting
- ✅ All tokens expire appropriately
- ✅ All sensitive data encrypted at rest
- ✅ OWASP Top 10 compliance

**Reliability:**
- ✅ 99.9% email delivery success rate
- ✅ Zero user lockouts (proper account recovery)
- ✅ Zero data loss during migrations
- ✅ <0.1% auth failure rate

### User Experience Metrics

**Adoption:**
- 🎯 >30% users enable 2FA within 3 months
- 🎯 >20% users register passkeys within 3 months
- 🎯 >40% users verify email within 1 week
- 🎯 <5 support tickets per week related to auth

**Satisfaction:**
- 🎯 Positive feedback on modern auth options
- 🎯 Reduced password reset requests (magic links)
- 🎯 Improved trust (email verification, 2FA badges)

---

## Final Checklist

- [ ] All 6 phases completed
- [ ] All tests passing
- [ ] Documentation complete
- [ ] Security audit passed
- [ ] Performance benchmarks met
- [ ] Team trained
- [ ] Users notified of new features
- [ ] Monitoring dashboards ready
- [ ] Rollback procedures tested
- [ ] 🎉 Launch!

---

## Next Steps

1. Monitor adoption metrics
2. Collect user feedback
3. Address any issues
4. Optimize performance
5. Plan future enhancements:
   - Biometric authentication
   - Hardware security key support
   - Risk-based authentication
   - Advanced threat detection
   - Compliance certifications (SOC 2, ISO 27001)
