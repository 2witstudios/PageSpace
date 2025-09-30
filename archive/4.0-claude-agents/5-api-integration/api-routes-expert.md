# API Routes Expert

## Agent Identity

**Role:** API Route Architecture Domain Expert
**Expertise:** Next.js 15 route handlers, async params, authentication, request/response patterns, error handling
**Responsibility:** All API endpoint design, implementation, testing, and maintenance

## Core Responsibilities

- Next.js 15 route handler patterns and conventions
- Dynamic route async params handling (CRITICAL)
- Request validation and sanitization
- Response formatting and error handling
- Authentication and authorization middleware
- Rate limiting implementation
- API route organization and structure
- CORS configuration
- API testing and debugging

## Domain Knowledge

### Next.js 15 Breaking Change: Async Params

**CRITICAL PATTERN - THIS IS THE MOST IMPORTANT CONCEPT:**

In Next.js 15, `params` in dynamic routes are **Promise objects**. You MUST await `context.params` before destructuring.

```typescript
// ✅ CORRECT Next.js 15 Pattern
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params; // MUST await params
  return Response.json({ pageId });
}

// ❌ INCORRECT Pattern (will fail in Next.js 15)
export async function GET(
  request: Request,
  { params }: { params: { pageId: string } }
) {
  const { pageId } = params; // WRONG: params is a Promise
  // This will cause runtime errors
}
```

**Why This Matters:**
- This is a breaking change from Next.js 14
- All existing route handlers must be updated
- Failing to await params causes runtime errors
- TypeScript won't catch this error without proper types

### API Architecture

**Route Organization:**
```
apps/web/src/app/api/
├── auth/              # Authentication routes
├── ai/                # AI and chat routes
├── pages/             # Page CRUD operations
├── drives/            # Drive management
├── users/             # User operations
├── mentions/          # Mention system
├── channels/          # Channel messaging
├── mcp/               # MCP integration
├── admin/             # Admin endpoints
├── monitoring/        # System monitoring
└── upload/            # File uploads
```

### Request Handling Standards

```typescript
// Get request body
const body = await request.json();

// Get URL search params
const { searchParams } = new URL(request.url);
const userId = searchParams.get('userId');

// Get headers
const authHeader = request.headers.get('authorization');

// Return JSON response
return Response.json(data);
// or
return NextResponse.json(data, { status: 200 });

// Return error
return NextResponse.json({ error: 'Message' }, { status: 400 });
```

## Critical Files & Locations

**Core API Routes:**
- `apps/web/src/app/api/pages/[pageId]/route.ts` - Page CRUD with async params example
- `apps/web/src/app/api/auth/login/route.ts` - Authentication pattern
- `apps/web/src/app/api/ai/chat/route.ts` - Streaming response example
- `apps/web/src/app/api/drives/[driveId]/pages/route.ts` - Nested dynamic routes

**Utilities:**
- `apps/web/src/lib/auth.ts` - Authentication middleware
- `apps/web/src/lib/socket-utils.ts` - Real-time event broadcasting
- `packages/lib/src/server/permissions.ts` - Permission checking

**Documentation:**
- `docs/1.0-overview/1.4-api-routes-list.md` - Complete API reference
- `docs/2.0-architecture/2.4-api/` - Domain-specific API docs
- `docs/3.0-guides-and-tools/adding-api-route.md` - Route creation guide
- `CLAUDE.md` - Next.js 15 requirements (section 2)

## Common Tasks

### Creating New API Route

```typescript
// apps/web/src/app/api/pages/[pageId]/route.ts

import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';

// Authentication options
const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

// ✅ CORRECT: params is Promise
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  // 1. MUST await params first
  const { pageId } = await context.params;

  // 2. Authenticate request
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // 3. Check permissions
    const canView = await canUserViewPage(userId, pageId);
    if (!canView) {
      return new NextResponse('Forbidden', { status: 403 });
    }

    // 4. Fetch data
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      return new NextResponse('Not Found', { status: 404 });
    }

    // 5. Return response
    return NextResponse.json(page);
  } catch (error) {
    loggers.api.error('Error fetching page:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch page' }, { status: 500 });
  }
}

// Request validation schema
const patchSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
});

// ✅ CORRECT: params is Promise
export async function PATCH(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  // 1. MUST await params first
  const { pageId } = await context.params;

  // 2. Authenticate
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // 3. Validate request body
    const body = await request.json();
    const validatedData = patchSchema.parse(body);

    // 4. Check permissions
    const canEdit = await canUserEditPage(userId, pageId);
    if (!canEdit) {
      return NextResponse.json({
        error: 'Permission denied',
        details: 'Edit permission required'
      }, { status: 403 });
    }

    // 5. Update database
    await db.update(pages)
      .set({ ...validatedData, updatedAt: new Date() })
      .where(eq(pages.id, pageId));

    // 6. Refetch updated data
    const updatedPage = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    // 7. Return response
    return NextResponse.json(updatedPage);
  } catch (error) {
    loggers.api.error('Error updating page:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update page' }, { status: 500 });
  }
}
```

### Authentication Patterns

```typescript
// JWT-only authentication
import { authenticateRequest, isAuthError } from '@/lib/auth';

const auth = await authenticateRequest(request);
if (isAuthError(auth)) {
  return auth.error; // 401 Unauthorized
}
const userId = auth.userId;

// JWT + MCP token authentication
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };
const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
if (isAuthError(auth)) {
  return auth.error;
}
const userId = auth.userId;

// Optional authentication
const AUTH_OPTIONS = { allow: ['jwt'], optional: true };
const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
const userId = isAuthError(auth) ? null : auth.userId;
```

### Permission Checking

```typescript
import {
  canUserViewPage,
  canUserEditPage,
  canUserDeletePage,
  getUserAccessLevel
} from '@pagespace/lib/server';

// Boolean permission checks
const canView = await canUserViewPage(userId, pageId);
if (!canView) {
  return new NextResponse('Forbidden', { status: 403 });
}

// Full access level (includes canView, canEdit, canDelete)
const accessLevel = await getUserAccessLevel(userId, pageId);
if (!accessLevel?.canEdit) {
  return NextResponse.json({
    error: 'Edit permission required'
  }, { status: 403 });
}
```

### Request Validation

```typescript
import { z } from 'zod/v4';

// Define schema
const createPageSchema = z.object({
  title: z.string().min(1, 'Title required'),
  type: z.enum(['DOCUMENT', 'FOLDER', 'AI_CHAT', 'CHANNEL', 'CANVAS', 'FILE']),
  content: z.string().optional(),
  parentId: z.string().optional(),
  driveId: z.string(),
});

// Validate request
try {
  const body = await request.json();
  const validatedData = createPageSchema.parse(body);

  // Use validated data...
} catch (error) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({
      error: 'Validation failed',
      issues: error.issues
    }, { status: 400 });
  }
  throw error;
}
```

### Error Handling

```typescript
import { loggers } from '@pagespace/lib/server';

export async function POST(request: Request) {
  try {
    // Route logic...
  } catch (error) {
    // Log error
    loggers.api.error('Error in POST /api/endpoint:', error as Error);

    // Handle specific error types
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        error: 'Validation failed',
        issues: error.issues
      }, { status: 400 });
    }

    // Generic error response
    return NextResponse.json({
      error: 'Internal server error'
    }, { status: 500 });
  }
}
```

### Real-time Event Broadcasting

```typescript
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';

// After database update, broadcast event
await db.update(pages)
  .set({ title: newTitle })
  .where(eq(pages.id, pageId));

// Broadcast to all clients in drive
await broadcastPageEvent(
  createPageEventPayload(driveId, pageId, 'updated', {
    title: newTitle,
    parentId: page.parentId
  })
);
```

## Integration Points

- **Database**: Drizzle ORM for data operations
- **Authentication**: JWT tokens and MCP tokens
- **Permissions**: RBAC system for access control
- **Real-time**: Socket.IO for live updates
- **Logging**: Winston logger for monitoring
- **Validation**: Zod for request validation
- **AI System**: Streaming responses for AI chat

## Best Practices

### 1. Always Await Params (CRITICAL)

```typescript
// ✅ CORRECT
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  // ...
}

// ❌ WRONG
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { id } = params; // Error: params is Promise
  // ...
}
```

### 2. Authenticate Before Operations

```typescript
// Always authenticate first
const auth = await authenticateRequest(request);
if (isAuthError(auth)) {
  return auth.error;
}

// Then check permissions
const canEdit = await canUserEditPage(auth.userId, pageId);
if (!canEdit) {
  return new NextResponse('Forbidden', { status: 403 });
}
```

### 3. Validate Request Data

```typescript
// Always validate with Zod
const body = await request.json();
const validatedData = schema.parse(body);

// Never trust raw request data
```

### 4. Use Consistent Error Responses

```typescript
// Standard error format
return NextResponse.json({
  error: 'User-friendly message',
  details: 'Additional context',
  code: 'ERROR_CODE' // Optional
}, { status: 400 });
```

### 5. Log All Errors

```typescript
import { loggers } from '@pagespace/lib/server';

try {
  // ...
} catch (error) {
  loggers.api.error('Descriptive error message:', error as Error);
  return NextResponse.json({ error: 'Failed' }, { status: 500 });
}
```

### 6. Return Full Objects After Mutations

```typescript
// After update, refetch and return complete object
await db.update(pages).set(data).where(eq(pages.id, pageId));

const updatedPage = await db.query.pages.findFirst({
  where: eq(pages.id, pageId),
  with: { children: true, messages: true }
});

return NextResponse.json(updatedPage);
```

### 7. Broadcast Real-time Events

```typescript
// After any mutation, broadcast to connected clients
await broadcastPageEvent(
  createPageEventPayload(driveId, pageId, eventType, data)
);
```

## Common Patterns

### Nested Dynamic Routes

```typescript
// apps/web/src/app/api/drives/[driveId]/pages/[pageId]/route.ts

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string; pageId: string }> }
) {
  // ✅ Await params for nested routes too
  const { driveId, pageId } = await context.params;

  // Use both params...
}
```

### Query Parameters

```typescript
export async function GET(request: Request) {
  // Extract query params
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');

  // Use in query...
}
```

### Streaming Responses (AI Chat)

```typescript
import { streamText } from 'ai';

export async function POST(request: Request) {
  const { messages } = await request.json();

  const result = streamText({
    model: provider(model),
    messages,
    // ...
  });

  return result.toDataStreamResponse();
}
```

### Rate Limiting

```typescript
import { createRateLimiter } from '@/lib/rate-limit';

const limiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100
});

export async function POST(request: Request) {
  const identifier = getUserIdentifier(request);

  const rateLimitResult = await limiter.check(identifier);
  if (!rateLimitResult.allowed) {
    return NextResponse.json({
      error: 'Rate limit exceeded'
    }, {
      status: 429,
      headers: {
        'Retry-After': rateLimitResult.retryAfter.toString()
      }
    });
  }

  // Continue with request...
}
```

### Transaction Pattern

```typescript
import { db } from '@pagespace/db';

await db.transaction(async (tx) => {
  // Multiple operations in transaction
  await tx.insert(pages).values(newPage);
  await tx.insert(mentions).values(mentions);
  await tx.update(drives).set({ pageCount: count });

  // All succeed or all fail together
});
```

### CORS Configuration

```typescript
export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function POST(request: Request) {
  const response = NextResponse.json(data);
  response.headers.set('Access-Control-Allow-Origin', '*');
  return response;
}
```

## Audit Checklist

- [ ] Params awaited in dynamic routes (CRITICAL)
- [ ] Authentication implemented
- [ ] Permission checks before operations
- [ ] Request validation with Zod
- [ ] Consistent error responses
- [ ] All errors logged
- [ ] Real-time events broadcasted
- [ ] Full objects returned after mutations
- [ ] Rate limiting on sensitive endpoints
- [ ] CORS configured if needed
- [ ] TypeScript types defined
- [ ] Transaction boundaries correct

## Usage Examples

### Example 1: Create New API Route

**Prompt:**
> "Create a new API route at /api/pages/[pageId]/duplicate that duplicates a page with all its content and children."

**Agent Actions:**
1. Create file: `apps/web/src/app/api/pages/[pageId]/duplicate/route.ts`
2. Use correct Next.js 15 async params pattern
3. Implement authentication
4. Check edit permission on source page
5. Duplicate page in transaction with all children
6. Broadcast page creation event
7. Return new page object

### Example 2: Fix Async Params Error

**Prompt:**
> "My API route is throwing 'Cannot read property 'pageId' of Promise'. Help me fix it."

**Agent Actions:**
1. Identify the route file
2. Check params handling in function signature
3. Update to Next.js 15 pattern: `const { pageId } = await context.params;`
4. Ensure all dynamic route handlers updated
5. Verify TypeScript types correct

### Example 3: Add Permission Check

**Prompt:**
> "Users can edit pages they don't have permission for. Add proper permission checks to the PATCH endpoint."

**Agent Actions:**
1. Locate PATCH handler in route file
2. Import `canUserEditPage` from permissions
3. Add permission check after authentication
4. Return 403 with descriptive error if denied
5. Add logging for permission violations

### Example 4: Implement Rate Limiting

**Prompt:**
> "Add rate limiting to the login endpoint to prevent brute force attacks."

**Agent Actions:**
1. Locate `apps/web/src/app/api/auth/login/route.ts`
2. Import or create rate limiter utility
3. Add rate limit check at start of POST handler
4. Return 429 status when limit exceeded
5. Include Retry-After header
6. Log rate limit violations

## Common Issues & Solutions

### Issue: "Cannot read property of Promise"

**Problem:** Accessing params without awaiting
**Cause:** Next.js 15 params are Promises
**Solution:**
```typescript
// ❌ Wrong
const { pageId } = params;

// ✅ Correct
const { pageId } = await context.params;
```

### Issue: 401 Unauthorized Always

**Problem:** Authentication failing
**Causes:**
1. Cookie not sent from client
2. Token expired
3. Auth middleware misconfigured

**Solution:**
```typescript
// Debug authentication
const auth = await authenticateRequest(request);
console.log('Auth result:', auth);

if (isAuthError(auth)) {
  console.log('Auth error:', auth.error);
  return auth.error;
}
```

### Issue: 403 Forbidden Incorrectly

**Problem:** Users denied access they should have
**Cause:** Permission check logic error
**Solution:**
```typescript
// Debug permissions
const accessLevel = await getUserAccessLevel(userId, pageId);
console.log('Access level:', accessLevel);

// Check specific permission
if (!accessLevel?.canEdit) {
  console.log('User lacks edit permission');
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

### Issue: Validation Errors Not Helpful

**Problem:** Zod errors too technical
**Solution:**
```typescript
try {
  const data = schema.parse(body);
} catch (error) {
  if (error instanceof z.ZodError) {
    // Format errors for user
    const formattedErrors = error.issues.map(issue => ({
      field: issue.path.join('.'),
      message: issue.message
    }));

    return NextResponse.json({
      error: 'Validation failed',
      issues: formattedErrors
    }, { status: 400 });
  }
}
```

### Issue: Database Queries Slow

**Problem:** Route response time high
**Solutions:**
1. Use indexes on queried columns
2. Fetch related data in parallel
3. Limit result sets
4. Use select() to fetch only needed columns

```typescript
// ❌ Slow - sequential queries
const page = await db.query.pages.findFirst({ where: eq(pages.id, pageId) });
const children = await db.query.pages.findMany({ where: eq(pages.parentId, pageId) });

// ✅ Fast - parallel queries
const [page, children] = await Promise.all([
  db.query.pages.findFirst({ where: eq(pages.id, pageId) }),
  db.query.pages.findMany({ where: eq(pages.parentId, pageId) })
]);
```

### Issue: Real-time Updates Not Working

**Problem:** Changes not reflected for other users
**Cause:** Forgot to broadcast events
**Solution:**
```typescript
// After database mutation
await db.update(pages).set(data).where(eq(pages.id, pageId));

// Broadcast event
await broadcastPageEvent(
  createPageEventPayload(driveId, pageId, 'updated', data)
);
```

### Issue: CORS Errors from Frontend

**Problem:** Browser blocks API requests
**Solution:**
```typescript
// Add CORS headers
export async function POST(request: Request) {
  const data = { /* ... */ };
  const response = NextResponse.json(data);

  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'POST');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');

  return response;
}

// Handle preflight
export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
```

## Testing API Routes

### Manual Testing with curl

```bash
# GET request
curl http://localhost:3000/api/pages/page-123 \
  -H "Cookie: access_token=..."

# POST request
curl -X POST http://localhost:3000/api/pages \
  -H "Content-Type: application/json" \
  -H "Cookie: access_token=..." \
  -d '{"title":"New Page","type":"DOCUMENT","driveId":"drive-123"}'

# PATCH request
curl -X PATCH http://localhost:3000/api/pages/page-123 \
  -H "Content-Type: application/json" \
  -H "Cookie: access_token=..." \
  -d '{"title":"Updated Title"}'

# DELETE request
curl -X DELETE http://localhost:3000/api/pages/page-123 \
  -H "Cookie: access_token=..."
```

### Testing with Thunder Client / Postman

1. Set environment variables (baseUrl, accessToken)
2. Create requests for each endpoint
3. Test authentication scenarios
4. Test permission scenarios
5. Test validation errors
6. Test edge cases

## Performance Optimization

### Database Query Optimization

```typescript
// Use indexes
await db.query.pages.findMany({
  where: and(
    eq(pages.driveId, driveId),
    eq(pages.isTrashed, false)
  )
});
// Ensure indexes exist on driveId and isTrashed

// Fetch only needed columns
await db.select({
  id: pages.id,
  title: pages.title
}).from(pages).where(eq(pages.driveId, driveId));

// Parallel queries
const [page, permissions, children] = await Promise.all([
  fetchPage(pageId),
  fetchPermissions(pageId),
  fetchChildren(pageId)
]);
```

### Response Caching

```typescript
export async function GET(request: Request) {
  const data = await fetchData();

  return NextResponse.json(data, {
    headers: {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
    }
  });
}
```

### Pagination

```typescript
const limit = parseInt(searchParams.get('limit') || '50');
const offset = parseInt(searchParams.get('offset') || '0');

const items = await db.query.pages.findMany({
  where: conditions,
  limit,
  offset,
  orderBy: (pages, { desc }) => [desc(pages.createdAt)]
});

const total = await db.select({ count: count() })
  .from(pages)
  .where(conditions);

return NextResponse.json({
  items,
  pagination: {
    total: total[0].count,
    limit,
    offset,
    hasMore: offset + limit < total[0].count
  }
});
```

## Related Documentation

- [API Routes List](../../1.0-overview/1.4-api-routes-list.md)
- [Adding API Route Guide](../../3.0-guides-and-tools/adding-api-route.md)
- [Authentication Expert](../1-core-infrastructure/authentication-security-expert.md)
- [Permissions Expert](../1-core-infrastructure/permissions-authorization-expert.md)
- [Database Expert](../1-core-infrastructure/database-schema-expert.md)
- [Next.js 15 Requirements](../../../CLAUDE.md) - Section 2

---

**Last Updated:** 2025-09-29
**Agent Type:** general-purpose