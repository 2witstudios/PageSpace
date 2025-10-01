# Phase 4: Extended OAuth Providers

**Timeline:** Week 7
**Risk Level:** LOW
**Dependencies:** None (uses native OAuth 2.0)

---

## Overview

This phase adds GitHub and Microsoft as OAuth providers alongside the existing Google OAuth. Users can sign up and login with these providers, and link/unlink them from their accounts.

**Features:**
- GitHub OAuth login and signup
- Microsoft OAuth login and signup
- Account linking (link multiple OAuth providers to one account)
- Provider unlinking
- Multiple provider support (email + Google + GitHub + Microsoft)

---

## Week 7: GitHub & Microsoft OAuth

### 7.1. Extend Provider Enum

**File:** `/packages/db/src/schema/auth.ts`

Update enum:

```typescript
export const authProvider = pgEnum('AuthProvider',
  ['email', 'google', 'github', 'microsoft', 'multiple']
);
```

**Migration:**
```bash
pnpm db:generate
pnpm db:migrate
```

### 7.2. GitHub OAuth Implementation

#### GitHub OAuth Sign-In Endpoint

**File:** `/apps/web/src/app/api/auth/github/signin/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GITHUB_OAUTH_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: 'GitHub OAuth not configured' }, { status: 500 });
  }

  // Generate state for CSRF protection
  const state = Math.random().toString(36).substring(7);

  // Store state in session/cookie for verification
  // For simplicity, using in-memory (use Redis in production)
  global.githubOAuthStates = global.githubOAuthStates || new Map();
  global.githubOAuthStates.set(state, {
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'read:user user:email');
  authUrl.searchParams.set('state', state);

  return NextResponse.redirect(authUrl.toString());
}
```

#### GitHub OAuth Callback Endpoint

**File:** `/apps/web/src/app/api/auth/github/callback/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, users, refreshTokens, drives, eq, or } from '@pagespace/db';
import { generateAccessToken, generateRefreshToken, slugify } from '@pagespace/lib/server';
import { serialize } from 'cookie';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
      return NextResponse.redirect(new URL(`/auth/signin?error=${error}`, baseUrl));
    }

    const validation = callbackSchema.safeParse({ code, state });
    if (!validation.success) {
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
      return NextResponse.redirect(new URL('/auth/signin?error=invalid_request', baseUrl));
    }

    const { code: authCode, state: authState } = validation.data;

    // Verify state (CSRF protection)
    const stateData = global.githubOAuthStates?.get(authState);
    if (!stateData || stateData.expiresAt < Date.now()) {
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
      return NextResponse.redirect(new URL('/auth/signin?error=invalid_state', baseUrl));
    }
    global.githubOAuthStates.delete(authState);

    // Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
        code: authCode,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      loggers.auth.error('No access token from GitHub');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    // Get user info from GitHub
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Accept': 'application/json',
      },
    });

    const githubUser = await userResponse.json();

    // Get primary email
    const emailsResponse = await fetch('https://api.github.com/user/emails', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Accept': 'application/json',
      },
    });

    const emails = await emailsResponse.json();
    const primaryEmail = emails.find((e: any) => e.primary)?.email || githubUser.email;

    if (!primaryEmail) {
      loggers.auth.error('No email from GitHub');
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
      return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
    }

    // Check if user exists
    let user = await db.query.users.findFirst({
      where: eq(users.email, primaryEmail),
    });

    const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] ||
                     request.headers.get('x-real-ip') ||
                     'unknown';

    if (user) {
      // Update existing user
      await db.update(users)
        .set({
          provider: user.password ? 'multiple' : 'github',
          name: user.name || githubUser.name || githubUser.login,
          image: githubUser.avatar_url,
          emailVerified: new Date(),
        })
        .where(eq(users.id, user.id));

      user = await db.query.users.findFirst({
        where: eq(users.id, user.id),
      }) || user;
    } else {
      // Create new user
      const [newUser] = await db.insert(users).values({
        id: createId(),
        name: githubUser.name || githubUser.login,
        email: primaryEmail,
        emailVerified: new Date(),
        image: githubUser.avatar_url,
        provider: 'github',
        tokenVersion: 0,
        role: 'user',
        storageUsedBytes: 0,
        subscriptionTier: 'free',
      }).returning();

      user = newUser;

      // Create personal drive
      const driveName = `${user.name}'s Drive`;
      const driveSlug = slugify(driveName);
      await db.insert(drives).values({
        name: driveName,
        slug: driveSlug,
        ownerId: user.id,
        updatedAt: new Date(),
      });
    }

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

    logAuthEvent('login', user.id, primaryEmail, clientIP, 'GitHub OAuth');
    trackAuthEvent(user.id, 'login', {
      email: primaryEmail,
      ip: clientIP,
      provider: 'github',
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
    loggers.auth.error('GitHub OAuth callback error', error as Error);
    const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || request.url;
    return NextResponse.redirect(new URL('/auth/signin?error=oauth_error', baseUrl));
  }
}
```

### 7.3. Microsoft OAuth Implementation

**Similar pattern to GitHub - implement:**
- `/api/auth/microsoft/signin` - Redirect to Microsoft authorization
- `/api/auth/microsoft/callback` - Handle callback

**Microsoft OAuth Endpoints:**
- Authorization: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`
- Token: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
- User Info: `https://graph.microsoft.com/v1.0/me`

**Microsoft OAuth uses standard OAuth 2.0 (no special library needed)**

**Key differences from GitHub:**
- Uses `tenant` parameter (use 'common' for multi-tenant)
- Scope: `openid profile email`
- User info from Microsoft Graph API
- Avatar URL: `https://graph.microsoft.com/v1.0/me/photo/$value`

### 7.4. Environment Variables

Add to `.env`:

```bash
# GitHub OAuth
GITHUB_OAUTH_CLIENT_ID=your-github-client-id
GITHUB_OAUTH_CLIENT_SECRET=your-github-client-secret
GITHUB_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/github/callback

# Microsoft OAuth
MICROSOFT_OAUTH_CLIENT_ID=your-microsoft-client-id
MICROSOFT_OAUTH_CLIENT_SECRET=your-microsoft-client-secret
MICROSOFT_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/microsoft/callback
MICROSOFT_OAUTH_TENANT=common  # or your tenant ID
```

### 7.5. OAuth Provider Setup

#### GitHub OAuth App Setup

1. Go to https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in details:
   - Application name: PageSpace (local)
   - Homepage URL: http://localhost:3000
   - Authorization callback URL: http://localhost:3000/api/auth/github/callback
4. Click "Register application"
5. Copy Client ID and generate Client Secret
6. Add to `.env`

#### Microsoft OAuth App Setup

1. Go to https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps
2. Click "New registration"
3. Fill in details:
   - Name: PageSpace (local)
   - Supported account types: Accounts in any organizational directory and personal Microsoft accounts
   - Redirect URI: Web - http://localhost:3000/api/auth/microsoft/callback
4. Click "Register"
5. Copy Application (client) ID
6. Go to "Certificates & secrets" → "New client secret"
7. Copy secret value
8. Add both to `.env`

---

## Frontend Integration

### Update Sign-In Page

Add GitHub and Microsoft sign-in buttons:

```tsx
<div className="space-y-3">
  <Button
    variant="outline"
    className="w-full"
    onClick={() => window.location.href = '/api/auth/google/signin'}
  >
    <GoogleIcon className="mr-2 h-5 w-5" />
    Continue with Google
  </Button>

  <Button
    variant="outline"
    className="w-full"
    onClick={() => window.location.href = '/api/auth/github/signin'}
  >
    <GithubIcon className="mr-2 h-5 w-5" />
    Continue with GitHub
  </Button>

  <Button
    variant="outline"
    className="w-full"
    onClick={() => window.location.href = '/api/auth/microsoft/signin'}
  >
    <MicrosoftIcon className="mr-2 h-5 w-5" />
    Continue with Microsoft
  </Button>
</div>
```

### Account Linking UI

Create a connected accounts section in settings:

```tsx
<div className="space-y-4">
  <h3 className="text-lg font-medium">Connected Accounts</h3>
  <div className="space-y-2">
    <div className="flex items-center justify-between p-4 border rounded-lg">
      <div className="flex items-center gap-3">
        <GoogleIcon className="h-6 w-6" />
        <div>
          <p className="font-medium">Google</p>
          <p className="text-sm text-muted-foreground">{user.email}</p>
        </div>
      </div>
      {user.provider === 'multiple' && (
        <Button variant="destructive" size="sm">Unlink</Button>
      )}
    </div>

    {/* Similar blocks for GitHub and Microsoft */}
  </div>
</div>
```

---

## Testing Checklist

- [ ] GitHub OAuth login works
- [ ] GitHub OAuth signup creates new user
- [ ] GitHub OAuth links to existing account (same email)
- [ ] Microsoft OAuth login works
- [ ] Microsoft OAuth signup creates new user
- [ ] Microsoft OAuth links to existing account
- [ ] State parameter prevents CSRF
- [ ] Error handling works for all OAuth errors
- [ ] User info fetched correctly from GitHub
- [ ] User info fetched correctly from Microsoft
- [ ] Avatar images display correctly
- [ ] Email verified on OAuth signup
- [ ] Personal drive created on signup
- [ ] Multiple providers can be linked to one account
- [ ] Provider shown as 'multiple' when email + OAuth used

---

## Security Considerations

1. **State Parameter:**
   - Cryptographically random state for CSRF protection
   - Store in session/memory with expiration
   - Validate on callback

2. **Email Verification:**
   - OAuth providers verify email ownership
   - Mark email as verified on OAuth signup
   - Trust OAuth provider's verification

3. **Account Linking:**
   - Link by email match
   - Update provider to 'multiple' when both email and OAuth used
   - Prevent unlinking last authentication method

4. **Secrets Management:**
   - Keep client secrets in environment variables
   - Never expose secrets to client
   - Rotate secrets periodically

---

## Next Phase

Once Phase 4 is complete and tested, proceed to:
**Phase 5: Magic Links** - See `docs/auth-phase-5-magic-links.md`
