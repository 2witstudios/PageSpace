# CSRF Protection Update Status

## Completed Routes (13 files)

### AI Conversations (4 files)
- [x] `/api/ai_conversations/route.ts` (GET, POST)
- [x] `/api/ai_conversations/[id]/route.ts` (GET, PATCH, DELETE)
- [x] `/api/ai_conversations/[id]/messages/route.ts` (GET, POST)
- [x] `/api/ai_conversations/global/route.ts` (GET)

### Auth Management (3 files)
- [x] `/api/auth/logout/route.ts` (POST)
- [x] `/api/auth/mcp-tokens/route.ts` (GET, POST)
- [x] `/api/auth/mcp-tokens/[tokenId]/route.ts` (DELETE)

### Drive Members (3 files)
- [x] `/api/drives/[driveId]/members/route.ts` (GET, POST)
- [x] `/api/drives/[driveId]/members/[userId]/route.ts` (GET, PATCH)
- [x] `/api/drives/[driveId]/members/invite/route.ts` (POST)

### Notifications (3 files)
- [x] `/api/notifications/[id]/read/route.ts` (PATCH)
- [x] `/api/notifications/[id]/route.ts` (DELETE)
- [x] `/api/notifications/read-all/route.ts` (PATCH)

## Remaining Routes (23+ files)

### Pages & Channels (3 files)
- [ ] `/api/pages/[pageId]/permissions/route.ts` (POST, DELETE)
- [ ] `/api/pages/[pageId]/agent-config/route.ts` (PATCH)
- [ ] `/api/channels/[pageId]/messages/route.ts` (POST)

### AI & Settings (4 files)
- [ ] `/api/ai/chat/route.ts` (POST, PATCH)
- [ ] `/api/ai/settings/route.ts` (POST, PATCH, DELETE)
- [ ] `/api/ai/tasks/[taskId]/status/route.ts` (PATCH)
- [ ] `/api/settings/notification-preferences/route.ts` (PATCH)

### Other Routes (16+ files)
- [ ] `/api/agents/consult/route.ts` (POST)
- [ ] `/api/connections/route.ts` (POST)
- [ ] `/api/connections/[connectionId]/route.ts` (PATCH, DELETE)
- [ ] `/api/contact/route.ts` (POST)
- [ ] `/api/debug/chat-messages/route.ts` (POST)
- [ ] `/api/files/[id]/convert-to-document/route.ts` (POST)
- [ ] `/api/messages/[conversationId]/route.ts` (POST, PATCH)
- [ ] `/api/messages/conversations/route.ts` (POST)
- [ ] `/api/pages/[pageId]/reprocess/route.ts` (POST)
- [ ] `/api/permissions/batch/route.ts` (POST)
- [ ] `/api/storage/check/route.ts` (POST)
- [ ] `/api/stripe/portal/route.ts` (POST)
- [ ] `/api/track/route.ts` (POST, PUT)
- [ ] `/api/trash/[pageId]/route.ts` (DELETE)
- [ ] `/api/trash/drives/[driveId]/route.ts` (DELETE)
- [ ] `/api/admin/users/[userId]/subscription/route.ts` (PUT)

## Update Pattern Applied

All routes converted from:
```typescript
const auth = await authenticateWebRequest(request);
// or
const user = await verifyAuth(request);
// or
const decoded = await decodeToken(accessToken);
```

To:
```typescript
const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
if (isAuthError(auth)) return auth.error;
const userId = auth.userId;
```

## Notes
- Import changed from `authenticateWebRequest` or `verifyAuth` to `authenticateRequestWithOptions, isAuthError`
- Variable naming: `user` → `userId` (or `currentUserId` where param conflict exists)
- All routes now have CSRF protection enabled
