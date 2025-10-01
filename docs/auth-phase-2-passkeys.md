# Phase 2: WebAuthn/Passkeys

**Timeline:** Week 3-4
**Risk Level:** LOW
**Dependencies:** @simplewebauthn/server, @simplewebauthn/browser

---

## Overview

This phase implements FIDO2-compliant passwordless authentication using passkeys (WebAuthn). Users can register biometric devices (Face ID, Touch ID, Windows Hello) or hardware security keys for secure, passwordless login.

**Features:**
- Passkey registration (Face ID, Touch ID, Windows Hello, security keys)
- Passwordless authentication via passkeys
- Multi-device passkey support
- Passkey management UI (list, rename, delete)
- Cross-platform compatibility (Chrome, Safari, Firefox, Edge)

---

## Week 3: Backend WebAuthn Integration

### 3.1. Install Dependencies

```bash
pnpm add @simplewebauthn/server @simplewebauthn/browser
```

**Why SimpleWebAuthn?**
- 200K weekly downloads (industry standard)
- FIDO2 certified
- Excellent TypeScript support
- Handles all WebAuthn complexity
- Works across Chrome, Safari, Firefox, Edge

### 3.2. Create Passkeys Table

**File:** `/packages/db/src/schema/auth.ts`

Add new table:

```typescript
export const passkeys = pgTable('passkeys', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credentialId').unique().notNull(), // Base64URL encoded
  credentialPublicKey: text('credentialPublicKey').notNull(), // Base64URL encoded
  counter: integer('counter').default(0).notNull(),
  credentialDeviceType: text('credentialDeviceType').notNull(), // 'singleDevice' | 'multiDevice'
  credentialBackedUp: boolean('credentialBackedUp').default(false).notNull(),
  transports: text('transports'), // JSON array: ['usb', 'nfc', 'ble', 'internal']
  deviceName: text('deviceName'), // User-friendly name
  lastUsed: timestamp('lastUsed', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdx: index('passkeys_user_id_idx').on(table.userId),
    credentialIdx: index('passkeys_credential_id_idx').on(table.credentialId),
  };
});

export const passkeysRelations = relations(passkeys, ({ one }) => ({
  user: one(users, {
    fields: [passkeys.userId],
    references: [users.id],
  }),
}));
```

**Migration:**
```bash
pnpm db:generate
pnpm db:migrate
```

### 3.3. Create WebAuthn Configuration

**File:** `/packages/lib/src/webauthn-config.ts`

```typescript
export function getWebAuthnConfig() {
  const rpName = process.env.RP_NAME || 'PageSpace';
  const rpID = process.env.RP_ID || 'localhost';
  const origin = process.env.RP_ORIGIN || 'http://localhost:3000';

  // In production, RP_ID should be the domain (e.g., 'pagespace.com')
  // Origin should include protocol (e.g., 'https://pagespace.com')

  return {
    rpName,
    rpID,
    origin,
  };
}
```

### 3.4. Create Passkey Registration Endpoints

#### Registration Options Endpoint

**File:** `/apps/web/src/app/api/auth/passkey/register/options/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, passkeys, eq } from '@pagespace/db';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { getWebAuthnConfig } from '@pagespace/lib/webauthn-config';

export async function POST(request: NextRequest) {
  try {
    // Require authentication to register passkeys
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user's existing passkeys
    const userPasskeys = await db.query.passkeys.findMany({
      where: eq(passkeys.userId, user.id),
    });

    const config = getWebAuthnConfig();

    // Generate registration options
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userID: user.id,
      userName: user.email,
      userDisplayName: user.name,
      // Prevent re-registration of existing passkeys
      excludeCredentials: userPasskeys.map((passkey) => ({
        id: Buffer.from(passkey.credentialId, 'base64url'),
        type: 'public-key',
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        authenticatorAttachment: 'platform', // Prefer platform authenticators
      },
    });

    // Store challenge in session or database for verification
    // For simplicity, we'll use a short-lived in-memory store
    // In production, use Redis or database
    global.passkeyRegistrationChallenges = global.passkeyRegistrationChallenges || new Map();
    global.passkeyRegistrationChallenges.set(user.id, {
      challenge: options.challenge,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    });

    return NextResponse.json(options);
  } catch (error) {
    console.error('Passkey registration options error:', error);
    return NextResponse.json(
      { error: 'Failed to generate registration options' },
      { status: 500 }
    );
  }
}
```

#### Registration Verification Endpoint

**File:** `/apps/web/src/app/api/auth/passkey/register/verify/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { verifyAuth } from '@/lib/auth';
import { db, passkeys } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { getWebAuthnConfig } from '@pagespace/lib/webauthn-config';
import { loggers } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

const verifySchema = z.object({
  response: z.any(), // WebAuthn registration response
  deviceName: z.string().optional(),
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

    const { response: attResp, deviceName } = validation.data;

    // Retrieve challenge
    const challengeData = global.passkeyRegistrationChallenges?.get(user.id);
    if (!challengeData) {
      return NextResponse.json({ error: 'Registration challenge not found' }, { status: 400 });
    }

    if (challengeData.expiresAt < Date.now()) {
      global.passkeyRegistrationChallenges.delete(user.id);
      return NextResponse.json({ error: 'Registration challenge expired' }, { status: 400 });
    }

    const config = getWebAuthnConfig();

    // Verify registration response
    const verification = await verifyRegistrationResponse({
      response: attResp,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: 'Verification failed' }, { status: 400 });
    }

    const { credentialPublicKey, credentialID, counter, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    // Store passkey in database
    await db.insert(passkeys).values({
      id: createId(),
      userId: user.id,
      credentialId: Buffer.from(credentialID).toString('base64url'),
      credentialPublicKey: Buffer.from(credentialPublicKey).toString('base64url'),
      counter,
      credentialDeviceType,
      credentialBackedUp,
      transports: attResp.response.transports ? JSON.stringify(attResp.response.transports) : null,
      deviceName: deviceName || `${credentialDeviceType} device`,
    });

    // Clear challenge
    global.passkeyRegistrationChallenges.delete(user.id);

    loggers.auth.info('Passkey registered', { userId: user.id, credentialDeviceType });
    trackAuthEvent(user.id, 'passkey_registered', { credentialDeviceType });

    return NextResponse.json({ verified: true });
  } catch (error) {
    console.error('Passkey registration verification error:', error);
    return NextResponse.json(
      { error: 'Failed to verify registration' },
      { status: 500 }
    );
  }
}
```

### 3.5. Create Passkey Authentication Endpoints

#### Authentication Options Endpoint

**File:** `/apps/web/src/app/api/auth/passkey/login/options/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { getWebAuthnConfig } from '@pagespace/lib/webauthn-config';

export async function POST(request: NextRequest) {
  try {
    const config = getWebAuthnConfig();

    // Generate authentication options
    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      userVerification: 'preferred',
    });

    // Store challenge for verification
    // In production, associate with session or use Redis
    global.passkeyAuthenticationChallenges = global.passkeyAuthenticationChallenges || new Map();
    const challengeId = Math.random().toString(36).substring(7);
    global.passkeyAuthenticationChallenges.set(challengeId, {
      challenge: options.challenge,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    });

    return NextResponse.json({ ...options, challengeId });
  } catch (error) {
    console.error('Passkey authentication options error:', error);
    return NextResponse.json(
      { error: 'Failed to generate authentication options' },
      { status: 500 }
    );
  }
}
```

#### Authentication Verification Endpoint

**File:** `/apps/web/src/app/api/auth/passkey/login/verify/route.ts`

See original plan for full implementation. This endpoint:
- Verifies authentication response
- Finds passkey by credential ID
- Validates authenticator data
- Updates counter and last used timestamp
- Generates JWT tokens
- Sets secure cookies
- Returns user data

### 3.6. Create Passkey Management Endpoints

#### List Passkeys Endpoint

**File:** `/apps/web/src/app/api/auth/passkey/list/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, passkeys, eq } from '@pagespace/db';

export async function GET(request: NextRequest) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userPasskeys = await db.query.passkeys.findMany({
      where: eq(passkeys.userId, user.id),
      columns: {
        id: true,
        credentialDeviceType: true,
        credentialBackedUp: true,
        deviceName: true,
        lastUsed: true,
        createdAt: true,
      },
      orderBy: (passkeys, { desc }) => [desc(passkeys.createdAt)],
    });

    return NextResponse.json({ passkeys: userPasskeys });
  } catch (error) {
    console.error('List passkeys error:', error);
    return NextResponse.json({ error: 'Failed to list passkeys' }, { status: 500 });
  }
}
```

#### Update/Delete Passkey Endpoint

**File:** `/apps/web/src/app/api/auth/passkey/[id]/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, passkeys, eq, and } from '@pagespace/db';

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

    // Delete passkey (only if it belongs to the user)
    const result = await db
      .delete(passkeys)
      .where(and(
        eq(passkeys.id, id),
        eq(passkeys.userId, user.id)
      ))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: 'Passkey not found' }, { status: 404 });
    }

    return NextResponse.json({ message: 'Passkey deleted successfully' });
  } catch (error) {
    console.error('Delete passkey error:', error);
    return NextResponse.json({ error: 'Failed to delete passkey' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const { deviceName } = await request.json();

    // Update passkey name
    const result = await db
      .update(passkeys)
      .set({ deviceName })
      .where(and(
        eq(passkeys.id, id),
        eq(passkeys.userId, user.id)
      ))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: 'Passkey not found' }, { status: 404 });
    }

    return NextResponse.json({ passkey: result[0] });
  } catch (error) {
    console.error('Update passkey error:', error);
    return NextResponse.json({ error: 'Failed to update passkey' }, { status: 500 });
  }
}
```

### 3.7. Environment Variables

Add to `.env`:

```bash
# WebAuthn Configuration
RP_NAME=PageSpace
RP_ID=localhost  # Use your domain in production (e.g., pagespace.com)
RP_ORIGIN=http://localhost:3000  # Use https://pagespace.com in production
```

---

## Week 4: Frontend Passkey UI

### 4.1. Passkey Registration UI

Create a passkey registration component in the settings page:

**Features:**
- Browser support detection
- Device naming input
- Registration flow with progress states
- Error handling and user feedback
- Visual confirmation on success

### 4.2. Passkey Login UI

Add passkey login option to the login page:

**Features:**
- "Sign in with passkey" button
- Browser support detection
- Loading states during authentication
- Error handling
- Fallback to password login

### 4.3. Passkey Management UI

Create a passkey management section in security settings:

**Features:**
- List all registered passkeys
- Show device type, name, last used date
- Rename passkey functionality
- Delete passkey with confirmation
- Visual indicators for platform vs cross-platform authenticators

### 4.4. Browser Support Detection

```typescript
export function isWebAuthnSupported(): boolean {
  return typeof window !== 'undefined' &&
         window.PublicKeyCredential !== undefined &&
         typeof window.PublicKeyCredential === 'function';
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;

  return window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}
```

---

## Testing Checklist

- [ ] Passkey registration works on Chrome (desktop + mobile)
- [ ] Passkey registration works on Safari (macOS + iOS)
- [ ] Passkey registration works on Firefox
- [ ] Passkey registration works on Edge
- [ ] Passkey authentication succeeds
- [ ] Counter updates correctly after each authentication
- [ ] Can register multiple passkeys per user
- [ ] Can rename passkeys
- [ ] Can delete passkeys
- [ ] Excluded credentials prevent duplicate registration
- [ ] Challenge expiration works (5 minutes)
- [ ] Error handling works for all failure cases
- [ ] Browser support detection works correctly

---

## Security Considerations

1. **Challenge Management:**
   - Challenges expire after 5 minutes
   - Challenges are single-use (deleted after verification)
   - In production, use Redis or database instead of in-memory storage

2. **Credential Storage:**
   - Public keys stored in database (never private keys)
   - Counter prevents replay attacks
   - Credential ID is unique and indexed

3. **Origin Validation:**
   - RP_ID must match domain
   - Origin must match exactly (including protocol)
   - Browser enforces same-origin policy

4. **User Verification:**
   - Set to 'preferred' to support all authenticator types
   - Platform authenticators (Face ID, Touch ID) provide built-in UV
   - Security keys may require PIN entry

---

## Troubleshooting

### Common Issues

1. **"NotAllowedError" during registration:**
   - User canceled the operation
   - Challenge expired
   - Origin mismatch

2. **"NotSupportedError":**
   - Browser doesn't support WebAuthn
   - HTTPS required (except localhost)

3. **Counter mismatch:**
   - Clone detection mechanism
   - Update counter after each use

4. **Excluded credentials not working:**
   - Ensure credential IDs are properly encoded as Base64URL
   - Check transports array format

---

## Next Phase

Once Phase 2 is complete and tested, proceed to:
**Phase 3: Two-Factor Authentication** - See `docs/auth-phase-3-2fa.md`
