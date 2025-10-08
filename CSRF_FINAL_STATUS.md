# CSRF Protection Implementation - Final Status

## ✅ Completed Routes (14 files - 39% complete)

### AI Conversations (4 files) ✅
- `/api/ai_conversations/route.ts` (GET, POST)
- `/api/ai_conversations/[id]/route.ts` (GET, PATCH, DELETE)
- `/api/ai_conversations/[id]/messages/route.ts` (GET, POST)
- `/api/ai_conversations/global/route.ts` (GET)

### Auth Management (3 files) ✅
- `/api/auth/logout/route.ts` (POST)
- `/api/auth/mcp-tokens/route.ts` (GET, POST)
- `/api/auth/mcp-tokens/[tokenId]/route.ts` (DELETE)

### Drive Members (3 files) ✅
- `/api/drives/[driveId]/members/route.ts` (GET, POST)
- `/api/drives/[driveId]/members/[userId]/route.ts` (GET, PATCH)
- `/api/drives/[driveId]/members/invite/route.ts` (POST)

### Notifications (3 files) ✅
- `/api/notifications/[id]/read/route.ts` (PATCH)
- `/api/notifications/[id]/route.ts` (DELETE)
- `/api/notifications/read-all/route.ts` (PATCH)

### Pages & Permissions (1 file) ✅
- `/api/pages/[pageId]/permissions/route.ts` (GET, POST, DELETE)

## 📋 Remaining Routes (22 files - 61% remaining)

### High Priority - State-Changing Operations

**Pages & Channels (2 files)**
- [ ] `/api/pages/[pageId]/agent-config/route.ts` (PATCH)
- [ ] `/api/channels/[pageId]/messages/route.ts` (POST)

**AI & Settings (4 files)**
- [ ] `/api/ai/chat/route.ts` (POST, PATCH)
- [ ] `/api/ai/settings/route.ts` (POST, PATCH, DELETE)
- [ ] `/api/ai/tasks/[taskId]/status/route.ts` (PATCH)
- [ ] `/api/settings/notification-preferences/route.ts` (PATCH)

**File & Content Operations (4 files)**
- [ ] `/api/files/[id]/convert-to-document/route.ts` (POST)
- [ ] `/api/pages/[pageId]/reprocess/route.ts` (POST)
- [ ] `/api/trash/[pageId]/route.ts` (DELETE)
- [ ] `/api/trash/drives/[driveId]/route.ts` (DELETE)

### Medium Priority

**Messages & Conversations (2 files)**
- [ ] `/api/messages/[conversationId]/route.ts` (POST, PATCH)
- [ ] `/api/messages/conversations/route.ts` (POST)

**Permissions & Connections (3 files)**
- [ ] `/api/permissions/batch/route.ts` (POST)
- [ ] `/api/connections/route.ts` (POST)
- [ ] `/api/connections/[connectionId]/route.ts` (PATCH, DELETE)

**Agents & Consulting (1 file)**
- [ ] `/api/agents/consult/route.ts` (POST)

### Lower Priority

**Analytics & Tracking (2 files)**
- [ ] `/api/track/route.ts` (POST, PUT)
- [ ] `/api/storage/check/route.ts` (POST)

**External Services (2 files)**
- [ ] `/api/contact/route.ts` (POST)
- [ ] `/api/stripe/portal/route.ts` (POST)

**Admin Operations (1 file)**
- [ ] `/api/admin/users/[userId]/subscription/route.ts` (PUT)

**Debug (1 file)**
- [ ] `/api/debug/chat-messages/route.ts` (POST)

## 🔧 Standard Update Pattern (Apply to All Remaining)

### Step 1: Update Imports
```typescript
// OLD
import { authenticateWebRequest, isAuthError } from '@/lib/auth';
// or
import { verifyAuth } from '@/lib/auth';
// or
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';

// NEW
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
```

### Step 2: Add Auth Options
```typescript
const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };
```

### Step 3: Update Auth Logic
```typescript
// OLD PATTERN 1
const auth = await authenticateWebRequest(request);
if (isAuthError(auth)) return auth.error;
const { userId } = auth;

// OLD PATTERN 2
const user = await verifyAuth(request);
if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
// Then use: user.id

// OLD PATTERN 3
const cookieHeader = req.headers.get('cookie');
const cookies = parse(cookieHeader || '');
const accessToken = cookies.accessToken;
if (!accessToken) return new NextResponse("Unauthorized", { status: 401 });
const decoded = await decodeToken(accessToken);
if (!decoded || !decoded.userId) return new NextResponse("Unauthorized", { status: 401 });
// Then use: decoded.userId

// NEW (All cases)
const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
if (isAuthError(auth)) return auth.error;
const userId = auth.userId;
```

### Step 4: Update Variable References
```typescript
// Replace all:
decoded.userId → userId
user.id → userId

// EXCEPTION: If route param is named userId
const { userId: targetUserId } = await context.params;
const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
if (isAuthError(auth)) return auth.error;
const currentUserId = auth.userId; // Use currentUserId for authenticated user
```

## 🧪 Testing Checklist

After completing all updates:

1. **Compilation:**
   ```bash
   pnpm typecheck
   ```

2. **Search for old patterns (should return 0):**
   ```bash
   grep -r "authenticateWebRequest" apps/web/src/app/api --include="route.ts"
   grep -r "verifyAuth.*request" apps/web/src/app/api --include="route.ts"
   grep -r "decodeToken.*accessToken" apps/web/src/app/api --include="route.ts"
   ```

3. **Count CSRF-protected routes:**
   ```bash
   grep -r "requireCSRF: true" apps/web/src/app/api --include="route.ts" | wc -l
   # Should be 36 when complete
   ```

4. **Manual Testing:**
   - [ ] Login/logout flow works
   - [ ] Creating/editing pages works
   - [ ] Permission management works
   - [ ] AI chat conversations work
   - [ ] File uploads work
   - [ ] All state-changing operations require CSRF token
   - [ ] 403 errors on missing/invalid CSRF tokens

## 📊 Progress Summary

- **Total Routes:** 36
- **Completed:** 14 (39%)
- **Remaining:** 22 (61%)
- **Estimated Time:** 3-4 hours for remaining routes
- **Average Time per Route:** 10-15 minutes

## 🎯 Next Steps

1. **Complete High Priority Routes** (10 files, ~2 hours)
   - Pages/Channels, AI/Settings, File operations

2. **Complete Medium Priority Routes** (6 files, ~1 hour)
   - Messages, Permissions, Connections, Agents

3. **Complete Lower Priority Routes** (6 files, ~1 hour)
   - Tracking, External services, Admin, Debug

4. **Testing & Verification** (~30 minutes)
   - TypeScript checks
   - Manual testing
   - Search for old patterns

5. **Documentation Update**
   - Update CHANGELOG.md
   - Update security documentation
   - Update API documentation

## 🔒 Security Benefits

Once complete, all API routes will have:
- ✅ CSRF protection against cross-site request forgery
- ✅ Consistent authentication pattern
- ✅ Proper error handling
- ✅ Type-safe request validation
- ✅ Centralized auth logic

## 📝 Notes

- All completed routes have been tested for TypeScript compilation
- Pattern is consistent across all updated files
- No breaking changes to API contract
- Frontend already sends CSRF tokens from cookies
- Backup files created during updates: `*.backup`

## 🆘 Help & Support

If issues arise:
1. Check `CSRF_COMPLETION_GUIDE.md` for detailed patterns
2. Review completed files as examples
3. Check TypeScript errors: `pnpm typecheck`
4. Test incrementally after every 5 routes

---

**Last Updated:** 2025-10-07
**Status:** 39% Complete (14/36 routes)
