# Phase 3: Two-Factor Authentication (2FA)

**Timeline:** Week 5-6
**Risk Level:** LOW
**Dependencies:** otpauth, qrcode

---

## Overview

This phase implements Time-based One-Time Password (TOTP) two-factor authentication with backup codes. Users can enable 2FA using authenticator apps like Google Authenticator, Authy, or 1Password.

**Features:**
- TOTP 2FA setup with QR code
- RFC 6238 compliant (works with all TOTP apps)
- Backup codes for account recovery
- 2FA verification during login
- 2FA enable/disable flow
- Security notifications

---

## Week 5: TOTP Backend

### 5.1. Install Dependencies

```bash
pnpm add otpauth qrcode @types/qrcode
```

**Why OTPAuth?**
- 50K weekly downloads
- RFC 6238 compliant (industry standard)
- Works with Google Authenticator, Authy, 1Password, etc.
- No external dependencies
- TypeScript support

### 5.2. Add 2FA Fields to Users Table

**File:** `/packages/db/src/schema/auth.ts`

Add to users table:

```typescript
export const users = pgTable('users', {
  // ... existing fields ...

  // Two-Factor Authentication
  twoFactorEnabled: boolean('twoFactorEnabled').default(false).notNull(),
  twoFactorSecret: text('twoFactorSecret'), // Encrypted TOTP secret

  // ... rest of fields ...
});
```

### 5.3. Create Backup Codes Table

```typescript
export const backupCodes = pgTable('backup_codes', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  code: text('code').notNull(), // Hashed with bcrypt
  usedAt: timestamp('usedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdx: index('backup_codes_user_id_idx').on(table.userId),
  };
});

export const backupCodesRelations = relations(backupCodes, ({ one }) => ({
  user: one(users, {
    fields: [backupCodes.userId],
    references: [users.id],
  }),
}));
```

**Migration:**
```bash
pnpm db:generate
pnpm db:migrate
```

### 5.4. Create 2FA Utility Functions

**File:** `/packages/lib/src/totp-utils.ts`

```typescript
import { TOTP } from 'otpauth';
import { encrypt, decrypt } from './encryption-utils';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';

export interface TOTPSetup {
  secret: string; // Encrypted
  uri: string; // For QR code
  backupCodes: string[]; // Plain text (show once)
}

export async function generateTOTPSecret(userEmail: string, issuer: string = 'PageSpace'): Promise<TOTPSetup> {
  // Generate TOTP secret
  const totp = new TOTP({
    issuer,
    label: userEmail,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });

  // Encrypt secret before storing
  const encryptedSecret = await encrypt(totp.secret.base32);

  // Generate 10 backup codes
  const backupCodes = Array.from({ length: 10 }, () =>
    randomBytes(4).toString('hex').toUpperCase()
  );

  return {
    secret: encryptedSecret,
    uri: totp.toString(),
    backupCodes,
  };
}

export async function verifyTOTP(encryptedSecret: string, token: string): Promise<boolean> {
  try {
    // Decrypt secret
    const secret = await decrypt(encryptedSecret);

    // Create TOTP instance
    const totp = new TOTP({
      secret,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });

    // Verify token (allow 1 period window for clock skew)
    const delta = totp.validate({ token, window: 1 });

    return delta !== null;
  } catch (error) {
    console.error('TOTP verification error:', error);
    return false;
  }
}

export async function hashBackupCode(code: string): Promise<string> {
  return bcrypt.hash(code, 10);
}

export async function verifyBackupCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}
```

### 5.5. Create 2FA Setup Endpoint

**File:** `/apps/web/src/app/api/auth/2fa/setup/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { generateTOTPSecret } from '@pagespace/lib/totp-utils';
import QRCode from 'qrcode';

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Generate TOTP secret and backup codes
    const setup = await generateTOTPSecret(user.email);

    // Generate QR code as data URL
    const qrCodeDataUrl = await QRCode.toDataURL(setup.uri);

    // Store secret temporarily in session/memory
    // User must verify TOTP before we save to database
    global.totp2FASetup = global.totp2FASetup || new Map();
    global.totp2FASetup.set(user.id, {
      secret: setup.secret,
      backupCodes: setup.backupCodes,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    return NextResponse.json({
      qrCode: qrCodeDataUrl,
      secret: setup.uri.split('secret=')[1]?.split('&')[0], // Extract secret for manual entry
      backupCodes: setup.backupCodes,
    });
  } catch (error) {
    console.error('2FA setup error:', error);
    return NextResponse.json({ error: 'Failed to setup 2FA' }, { status: 500 });
  }
}
```

### 5.6. Create 2FA Verification Endpoint

**File:** `/apps/web/src/app/api/auth/2fa/verify-setup/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { verifyAuth } from '@/lib/auth';
import { db, users, backupCodes, eq } from '@pagespace/db';
import { verifyTOTP, hashBackupCode } from '@pagespace/lib/totp-utils';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

const verifySchema = z.object({
  token: z.string().length(6),
});

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const validation = verifySchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { errors: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { token } = validation.data;

    // Retrieve setup data
    const setupData = global.totp2FASetup?.get(user.id);
    if (!setupData) {
      return NextResponse.json({ error: '2FA setup not found. Please start setup again.' }, { status: 400 });
    }

    if (setupData.expiresAt < Date.now()) {
      global.totp2FASetup.delete(user.id);
      return NextResponse.json({ error: '2FA setup expired. Please start again.' }, { status: 400 });
    }

    // Verify TOTP token
    const isValid = await verifyTOTP(setupData.secret, token);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid verification code' }, { status: 400 });
    }

    // Enable 2FA and save secret
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          twoFactorEnabled: true,
          twoFactorSecret: setupData.secret,
        })
        .where(eq(users.id, user.id));

      // Hash and save backup codes
      for (const code of setupData.backupCodes) {
        const hashedCode = await hashBackupCode(code);
        await tx.insert(backupCodes).values({
          id: createId(),
          userId: user.id,
          code: hashedCode,
        });
      }
    });

    // Clear setup data
    global.totp2FASetup.delete(user.id);

    loggers.auth.info('2FA enabled', { userId: user.id });
    trackAuthEvent(user.id, '2fa_enabled', {});

    return NextResponse.json({ message: '2FA enabled successfully' });
  } catch (error) {
    console.error('2FA verification error:', error);
    return NextResponse.json({ error: 'Failed to verify 2FA setup' }, { status: 500 });
  }
}
```

### 5.7. Update Login Route for 2FA

**File:** `/apps/web/src/app/api/auth/login/route.ts`

Add after password verification (around line 76):

```typescript
// After password verification succeeds...

// Check if 2FA is enabled
if (user.twoFactorEnabled) {
  const twoFactorToken = body.twoFactorToken;

  if (!twoFactorToken) {
    // Return special response indicating 2FA required
    return Response.json({
      requiresTwoFactor: true,
      userId: user.id, // Don't send full user data yet
    }, { status: 200 });
  }

  // Verify 2FA token
  const isTOTPValid = user.twoFactorSecret
    ? await verifyTOTP(user.twoFactorSecret, twoFactorToken)
    : false;

  let isBackupCodeValid = false;
  if (!isTOTPValid) {
    // Try backup code
    const userBackupCodes = await db.query.backupCodes.findMany({
      where: and(
        eq(backupCodes.userId, user.id),
        isNull(backupCodes.usedAt)
      ),
    });

    for (const backupCode of userBackupCodes) {
      if (await verifyBackupCode(twoFactorToken, backupCode.code)) {
        isBackupCodeValid = true;
        // Mark backup code as used
        await db
          .update(backupCodes)
          .set({ usedAt: new Date() })
          .where(eq(backupCodes.id, backupCode.id));
        break;
      }
    }
  }

  if (!isTOTPValid && !isBackupCodeValid) {
    logAuthEvent('failed', user.id, email, clientIP, 'Invalid 2FA token');
    trackAuthEvent(user.id, 'failed_2fa', { email, ip: clientIP });
    return Response.json({ error: 'Invalid two-factor authentication code' }, { status: 401 });
  }

  logAuthEvent('2fa_verified', user.id, email, clientIP);
}

// Continue with normal login flow (generate tokens, etc.)
```

### 5.8. Create 2FA Disable Endpoint

**File:** `/apps/web/src/app/api/auth/2fa/disable/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { verifyAuth } from '@/lib/auth';
import { db, users, backupCodes, eq } from '@pagespace/db';
import { verifyTOTP } from '@pagespace/lib/totp-utils';
import { loggers } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

const disableSchema = z.object({
  token: z.string().length(6),
});

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!user.twoFactorEnabled) {
      return NextResponse.json({ error: '2FA is not enabled' }, { status: 400 });
    }

    const body = await request.json();
    const validation = disableSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { errors: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { token } = validation.data;

    // Verify TOTP token before disabling
    const isValid = user.twoFactorSecret
      ? await verifyTOTP(user.twoFactorSecret, token)
      : false;

    if (!isValid) {
      return NextResponse.json({ error: 'Invalid verification code' }, { status: 400 });
    }

    // Disable 2FA and remove backup codes
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          twoFactorEnabled: false,
          twoFactorSecret: null,
        })
        .where(eq(users.id, user.id));

      // Delete all backup codes
      await tx
        .delete(backupCodes)
        .where(eq(backupCodes.userId, user.id));
    });

    loggers.auth.info('2FA disabled', { userId: user.id });
    trackAuthEvent(user.id, '2fa_disabled', {});

    return NextResponse.json({ message: '2FA disabled successfully' });
  } catch (error) {
    console.error('2FA disable error:', error);
    return NextResponse.json({ error: 'Failed to disable 2FA' }, { status: 500 });
  }
}
```

---

## Week 6: 2FA Frontend & Polish

### 6.1. 2FA Setup Wizard

Create a step-by-step wizard in security settings:

**Steps:**
1. Introduction explaining 2FA benefits
2. QR code display with manual entry option
3. Backup codes display with download option
4. Verification step (enter code from authenticator)
5. Success confirmation

**Features:**
- Copy secret key button
- Download backup codes as text file
- Print backup codes option
- Clear instructions for each step
- Error handling and validation

### 6.2. TOTP Verification UI on Login

Update login page to handle 2FA:

**Features:**
- Two-step login flow (password → 2FA)
- TOTP code input (6 digits)
- "Use backup code" toggle
- Resend code option (via email - future enhancement)
- Clear error messages
- Auto-submit on 6 digits entered

### 6.3. Backup Codes Management

Create backup codes management UI:

**Features:**
- View remaining backup codes count
- Regenerate backup codes (requires TOTP verification)
- Download new codes
- Warning when only 2 codes remain

### 6.4. Security Settings UI Updates

Update security settings page:

**Features:**
- 2FA status badge (enabled/disabled)
- Enable 2FA button
- Disable 2FA button (requires TOTP verification)
- View backup codes (requires TOTP verification)
- Security recommendations

---

## Testing Checklist

- [ ] 2FA setup flow completes successfully
- [ ] QR code generates correctly
- [ ] Manual secret entry works
- [ ] Backup codes are generated (10 codes)
- [ ] TOTP verification works with Google Authenticator
- [ ] TOTP verification works with Authy
- [ ] TOTP verification works with 1Password
- [ ] Backup codes work for login
- [ ] Backup codes are marked as used
- [ ] Used backup codes cannot be reused
- [ ] 2FA disable flow works
- [ ] All backup codes deleted on disable
- [ ] Login requires 2FA when enabled
- [ ] Clock skew tolerance works (±1 period)
- [ ] 2FA setup expires after 10 minutes
- [ ] Error handling works for all failure cases

---

## Security Considerations

1. **Secret Storage:**
   - TOTP secrets encrypted with AES-256-GCM
   - Secrets never sent to client (except during setup)
   - Secrets deleted when 2FA disabled

2. **Backup Codes:**
   - 10 codes generated (8-character hex, uppercase)
   - Hashed with bcrypt before storage
   - Single-use (marked as used after verification)
   - Deleted when 2FA disabled

3. **Clock Skew:**
   - Allow ±1 period (30 seconds) window
   - Prevents issues with slightly out-of-sync clocks

4. **Rate Limiting:**
   - Login endpoint already rate-limited
   - Consider additional rate limiting for 2FA attempts

5. **Recovery:**
   - Backup codes for account recovery
   - Consider admin override for locked accounts
   - Email notification when 2FA disabled

---

## User Experience Best Practices

1. **Setup Flow:**
   - Clear explanation of benefits
   - Step-by-step wizard
   - Test verification before enabling
   - Download backup codes before completion

2. **Login Flow:**
   - Remember device option (future enhancement)
   - Clear error messages
   - "Lost access?" link to recovery flow

3. **Backup Codes:**
   - Emphasize importance
   - Make download/print easy
   - Warn when running low
   - Easy regeneration

---

## Next Phase

Once Phase 3 is complete and tested, proceed to:
**Phase 4: Extended OAuth Providers** - See `docs/auth-phase-4-oauth-providers.md`
