# How to Add a New API Route

This guide provides instructions for adding new API routes to the web application, following the conventions established in the Next.js App Router.

## 1. File and Folder Structure

API routes are located in `apps/web/src/app/api/`. Each route is defined by a `route.ts` file within a directory that maps to the URL path.

-   **Static Routes**: For a route like `/api/users/find`, the file is at `apps/web/src/app/api/users/find/route.ts`.
-   **Dynamic Routes**: For a route like `/api/pages/[pageId]`, the file is at `apps/web/src/app/api/pages/[pageId]/route.ts`.

## 2. Route Handler Functions

Each `route.ts` file exports async functions corresponding to HTTP methods (e.g., `GET`, `POST`, `PUT`, `DELETE`).

**CRITICAL**: All API route handlers in Next.js 15 MUST be `async` functions that return a `Response` or `NextResponse` object.

### Example: `GET` Handler

```typescript
// Example: apps/web/src/app/api/auth/me/route.ts
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  // Your logic here
  return NextResponse.json({ message: 'Hello, world!' });
}
```

### Example: `POST` Handler

```typescript
// Example: apps/web/src/app/api/auth/signup/route.ts
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const body = await request.json();
  // Your logic here
  return NextResponse.json({ received: body }, { status: 201 });
}
```

## 3. Handling Request Data

### Dynamic Route Parameters

In Next.js 15, dynamic route parameters (`context.params`) are **Promises** and must be awaited.

```typescript
// Example: apps/web/src/app/api/pages/[pageId]/route.ts
import { NextResponse } from 'next/server';

export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params; // MUST await
  return NextResponse.json({ pageId });
}
```

### Search Parameters

Use the `URL` constructor to get search parameters from the request URL.

```typescript
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');
  return NextResponse.json({ name });
}
```

### Request Body

To get the body of a `POST` or `PUT` request, use the `.json()` method.

```typescript
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const data = await request.json();
  return NextResponse.json({ data });
}
```

## 4. Authentication, CSRF, and Origin Validation

Most routes require authentication. PageSpace uses a unified authentication system with built-in CSRF protection and Origin header validation for mutation operations.

**Defense-in-Depth Security:**
- **CSRF Token Validation**: Verifies the `X-CSRF-Token` header matches the session
- **Origin Header Validation**: Ensures requests originate from allowed domains (enabled automatically when `requireCSRF: true`)

### Standard Authentication Pattern

Use `authenticateRequestWithOptions` from `@/lib/auth` for all authenticated routes:

```typescript
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Define authentication options at the top of the file
const AUTH_OPTIONS = {
  allow: ['jwt', 'mcp'] as const,  // Allow JWT (web) and MCP (API) tokens
  requireCSRF: true                 // Enable CSRF + Origin validation for mutations
};

export async function POST(request: Request) {
  // Authenticate the request
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  const role = auth.role;

  // Proceed with authenticated logic
  return NextResponse.json({ userId });
}
```

### CSRF and Origin Protection

**CSRF protection is REQUIRED for all mutation endpoints** (POST, PUT, PATCH, DELETE) to prevent Cross-Site Request Forgery attacks.

When `requireCSRF: true` is set, **Origin header validation is automatically enabled** as defense-in-depth. This ensures that even if a browser vulnerability bypasses SameSite cookie protections, requests from unexpected origins will be rejected.

**When to use `requireCSRF: true`:**
- ✅ All POST/PUT/PATCH/DELETE endpoints that modify data
- ✅ Routes that accept JWT authentication (cookie-based)
- ❌ GET/HEAD/OPTIONS endpoints (safe methods)
- ❌ Routes that ONLY accept MCP tokens (Bearer auth, not cookies)
- ❌ Auth establishment endpoints: `/api/auth/login`, `/api/auth/signup`
- ❌ OAuth callback endpoints: `/api/auth/google/**`
- ❌ Webhook endpoints with alternative verification (e.g., Stripe signatures)

**Example: Mutation endpoint with CSRF protection**

```typescript
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';

const AUTH_OPTIONS = {
  allow: ['jwt', 'mcp'] as const,
  requireCSRF: true  // CSRF + Origin validation for mutations
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  // Authenticate and validate CSRF token + Origin header
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;  // Returns 401 for auth failure or 403 for CSRF/Origin failure
  }

  const { pageId } = await context.params;
  const userId = auth.userId;

  // Your update logic here
  const body = await request.json();
  await db.update(pages).set(body).where(eq(pages.id, pageId));

  return NextResponse.json({ success: true });
}
```

**Example: Read-only endpoint without CSRF**

```typescript
const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };  // No requireCSRF

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Read-only logic
  return NextResponse.json({ data: [] });
}
```

### Authentication Options

| Option | Type | Description |
|--------|------|-------------|
| `allow` | `['jwt'] \| ['mcp'] \| ['jwt', 'mcp']` | Which token types to accept |
| `requireCSRF` | `boolean` | Enable CSRF validation (only applies to JWT tokens). Also enables Origin validation. |
| `requireOriginValidation` | `boolean` | Override Origin validation (auto-enabled with `requireCSRF`). Set to `false` to disable. |

### Token Types

- **JWT tokens**: Cookie-based authentication for web users
- **MCP tokens**: Bearer token authentication for Model Context Protocol integrations

### Legacy Pattern (Deprecated)

The old pattern using `decodeToken` directly is deprecated. Always use `authenticateRequestWithOptions`:

```typescript
// ❌ OLD - Don't use
const decoded = await decodeToken(accessToken);

// ✅ NEW - Use this
const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
if (isAuthError(auth)) return auth.error;
```

## 5. Data Access and Error Handling

Use the Drizzle ORM instance from `@pagespace/db` to interact with the database. Always wrap database queries in a `try...catch` block to handle potential errors gracefully.

```typescript
import { NextResponse } from 'next/server';
import { db, users } from '@pagespace/db';
import { eq } from 'drizzle-orm';

export async function GET(request: Request) {
  try {
    const allUsers = await db.select().from(users);
    return NextResponse.json(allUsers);
  } catch (error) {
    console.error('Failed to fetch users:', error);
    return NextResponse.json(
      { error: 'Failed to fetch users' },
      { status: 500 }
    );
  }
}
```

## 6. Updating API Documentation

After adding or modifying an API route, you **MUST** update the central API documentation. Refer to the format specified in `api_routes.md` and add or update the relevant file in `docs/2.0-architecture/2.4-api/`.
**Last Updated:** 2026-01-01 (Added Origin header validation as defense-in-depth)