# CSRF Protection - Completion Guide

## Summary of Work Completed

Successfully updated **13 route files** with CSRF protection:

### ✅ Completed (13 files)
1. AI Conversations (4 files) - All GET/POST/PATCH/DELETE handlers
2. Auth Management (3 files) - logout, MCP tokens
3. Drive Members (3 files) - members management, invitations
4. Notifications (3 files) - read, delete, mark all read

## Remaining Routes to Update (23 files)

### Pattern to Apply to All Remaining Routes

**Step 1: Update Imports**

Replace:
```typescript
import { authenticateWebRequest, isAuthError } from '@/lib/auth';
// or
import { verifyAuth } from '@/lib/auth';
// or
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
```

With:
```typescript
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
```

**Step 2: Add AUTH_OPTIONS constant**

Add after imports, before first export:
```typescript
const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };
```

**Step 3: Update Auth Logic**

Replace:
```typescript
const auth = await authenticateWebRequest(request);
if (isAuthError(auth)) return auth.error;
const { userId } = auth;
```

Or replace:
```typescript
const user = await verifyAuth(request);
if (!user) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

Or replace:
```typescript
const cookieHeader = req.headers.get('cookie');
const cookies = parse(cookieHeader || '');
const accessToken = cookies.accessToken;

if (!accessToken) {
  return new NextResponse("Unauthorized", { status: 401 });
}

const decoded = await decodeToken(accessToken);
if (!decoded || !decoded.userId) {
  return new NextResponse("Unauthorized", { status: 401 });
}
```

With:
```typescript
const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
if (isAuthError(auth)) return auth.error;
const userId = auth.userId;
```

**Step 4: Update Variable References**

Replace all references to:
- `decoded.userId` → `userId`
- `user.id` → `userId`
- In routes with param named `userId`, use `currentUserId` instead

## Remaining Files by Category

### Pages & Channels (3)
- [ ] `/api/pages/[pageId]/permissions/route.ts` - GET, POST, DELETE
- [ ] `/api/pages/[pageId]/agent-config/route.ts` - PATCH
- [ ] `/api/channels/[pageId]/messages/route.ts` - POST

### AI & Settings (4)
- [ ] `/api/ai/chat/route.ts` - POST, PATCH
- [ ] `/api/ai/settings/route.ts` - POST, PATCH, DELETE
- [ ] `/api/ai/tasks/[taskId]/status/route.ts` - PATCH
- [ ] `/api/settings/notification-preferences/route.ts` - PATCH

### General API Routes (16)
- [ ] `/api/agents/consult/route.ts` - POST
- [ ] `/api/connections/route.ts` - POST
- [ ] `/api/connections/[connectionId]/route.ts` - PATCH, DELETE
- [ ] `/api/contact/route.ts` - POST
- [ ] `/api/debug/chat-messages/route.ts` - POST
- [ ] `/api/files/[id]/convert-to-document/route.ts` - POST
- [ ] `/api/messages/[conversationId]/route.ts` - POST, PATCH
- [ ] `/api/messages/conversations/route.ts` - POST
- [ ] `/api/pages/[pageId]/reprocess/route.ts` - POST
- [ ] `/api/permissions/batch/route.ts` - POST
- [ ] `/api/storage/check/route.ts` - POST
- [ ] `/api/stripe/portal/route.ts` - POST
- [ ] `/api/track/route.ts` - POST, PUT
- [ ] `/api/trash/[pageId]/route.ts` - DELETE
- [ ] `/api/trash/drives/[driveId]/route.ts` - DELETE
- [ ] `/api/admin/users/[userId]/subscription/route.ts` - PUT

## Quick Find Commands

Find all files still using old auth:
```bash
grep -r "authenticateWebRequest\|verifyAuth" apps/web/src/app/api --include="route.ts" | grep -v node_modules
```

Find files that already have CSRF protection:
```bash
grep -r "requireCSRF" apps/web/src/app/api --include="route.ts" | wc -l
```

## Verification Steps

After completing all updates:

1. **TypeScript Check:**
   ```bash
   pnpm typecheck
   ```

2. **Search for Old Patterns:**
   ```bash
   # Should return 0 results in route files
   grep -r "authenticateWebRequest" apps/web/src/app/api/
   grep -r "verifyAuth.*request" apps/web/src/app/api/
   ```

3. **Verify CSRF Coverage:**
   ```bash
   # Count routes with CSRF
   grep -r "requireCSRF: true" apps/web/src/app/api --include="route.ts" | wc -l
   ```

4. **Test Critical Paths:**
   - Login/logout flow
   - Creating/editing pages
   - AI chat interactions
   - Permission management
   - File uploads

## Special Cases to Watch For

1. **Routes with both JWT and MCP auth:**
   ```typescript
   const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };
   ```

2. **Routes with optional auth:**
   ```typescript
   const AUTH_OPTIONS = { allow: ['jwt'] as const, optional: true, requireCSRF: true };
   ```

3. **Exempt routes (DO NOT add CSRF):**
   - `/api/auth/login`
   - `/api/auth/signup`
   - `/api/auth/refresh`
   - `/api/auth/google`
   - `/api/stripe/webhook`
   - `/api/internal/*`
   - Any MCP-only routes

4. **Variable naming conflicts:**
   When route param is `userId` and you need current user:
   ```typescript
   const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
   if (isAuthError(auth)) return auth.error;
   const currentUserId = auth.userId; // Use currentUserId

   const { userId } = await context.params; // Param userId
   ```

## Testing Checklist

- [ ] All routes compile without TypeScript errors
- [ ] CSRF token included in all state-changing requests
- [ ] Old auth helpers removed from imports
- [ ] No remaining `decodeToken` calls in routes
- [ ] No remaining `verifyAuth` calls in routes
- [ ] No remaining `authenticateWebRequest` calls in routes
- [ ] Frontend sends CSRF tokens from cookies
- [ ] 403 errors on missing/invalid CSRF tokens

## Progress Tracking

- Completed: 13/36 files (36%)
- Remaining: 23/36 files (64%)
- Estimated time: ~2-3 hours for remaining files

## Notes

- Each file typically takes 2-5 minutes to update
- Routes with multiple handlers (GET/POST/PATCH/DELETE) take longer
- Test after every 5-10 files to catch issues early
- Keep backups of modified files until testing confirms success
