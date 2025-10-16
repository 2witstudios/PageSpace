# PageSpace Scripts

This directory contains utility scripts for code quality, security, and maintenance tasks.

## check-fetch-auth.js

**Purpose:** AST-based scanner to detect unauthenticated `fetch()` calls in client-side code.

**What it does:**
- Parses TypeScript/JavaScript files using Abstract Syntax Tree (AST) analysis
- Identifies all `fetch()` calls in client-side code
- Checks if they should be using `fetchWithAuth()` for CSRF-protected endpoints
- Excludes known exceptions (auth flows, server-side code, external APIs)

**Usage:**
```bash
pnpm check:fetch
```

**Exit codes:**
- `0` - All client-side fetch calls are properly authenticated
- `1` - Found violations (unauthenticated fetch calls that should use fetchWithAuth)

**What gets scanned:**
- `apps/web/src/components`
- `apps/web/src/hooks`
- `apps/web/src/stores`
- `apps/web/src/lib/editor`
- `apps/web/src/app/(dashboard)`

**What gets excluded:**
- Server-side API routes (`/app/api/`)
- Server middleware
- The `auth-fetch.ts` implementation itself
- Internal service calls (`socket-utils.ts`)
- External API calls (`model-capabilities.ts`)

**Expected auth flow files:**
These files are allowed to use native `fetch()` for auth endpoints:
- `use-auth.ts` - Login/signup flows
- `auth-store.ts` - Auth state management
- `use-token-refresh.ts` - Token refresh logic
- `socketStore.ts` - Socket reconnection
- `signin/page.tsx` - Sign-in page
- `signup/page.tsx` - Sign-up page

**Expected auth endpoints:**
These endpoints don't require CSRF protection:
- `/api/auth/login`
- `/api/auth/signup`
- `/api/auth/refresh`
- `/api/auth/me`
- `/api/auth/google/signin`
- `/api/auth/google/callback`

**Output example:**
```
🔍 Scanning for unauthenticated fetch calls...

📊 Results:

Total files found: 187
Files scanned: 187
Authenticated wrapper usage: 113
Auth flow fetch calls: 4
Potential violations: 0

✅ Auth Flow Calls (expected to use native fetch):

  /path/to/use-auth.ts:68 - /api/auth/login (auth endpoint)
  /path/to/use-token-refresh.ts:61 - /api/auth/refresh (auth endpoint)
  /path/to/auth-store.ts:229 - /api/auth/me (auth endpoint)
  /path/to/socketStore.ts:95 - /api/auth/refresh (auth endpoint)

✅ All client-side fetch calls are properly authenticated!

Found 113 uses of fetchWithAuth/post/patch/del
```

**When to run:**
- Before committing changes to client-side code
- In CI/CD pipeline to prevent regressions
- After adding new API endpoints
- During security audits

**Integration with CI:**
Add to your CI pipeline:
```yaml
- name: Check for unauthenticated fetch calls
  run: pnpm check:fetch
```

This will fail the build if any violations are detected.
