# Review Vector: MCP Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/mcp/**/route.ts`, `apps/web/src/app/api/mcp-ws/**/route.ts`, `apps/web/src/app/api/auth/mcp-tokens/**/route.ts`, Hybrid routes across `apps/web/src/app/api/**/route.ts` with `allow: ['session', 'mcp']`
**Level**: route

## Context
MCP routes implement the Model Context Protocol integration, allowing external AI tools (like Claude Code) to read and write PageSpace documents and list drives. The MCP-WS endpoint provides a WebSocket transport for persistent MCP connections. MCP token routes under auth manage token creation, listing, and revocation for API access without browser sessions. MCP tokens are long-lived bearer tokens with scoped permissions, so token generation must enforce proper entropy, and document operations must respect the token's permission scope rather than granting blanket access to the token owner's full account.

## MCP Scope Enforcement Requirements

### Critical Security Pattern

All hybrid routes that accept `allow: ['session', 'mcp']` **must** enforce MCP token scope restrictions. This prevents scoped MCP tokens from accessing resources outside their intended drive boundaries.

### Required Scope Checks

1. **Page-level operations**: Use `checkMCPPageScope(auth, pageId)` before accessing any page
   - Applies to: page GET/PATCH/DELETE, exports, history, agent-config, tasks

2. **Drive-level operations**: Use `checkMCPDriveScope(auth, driveId)` before accessing any drive
   - Applies to: drive operations, tree fetch, drive-specific search, trash/restore

3. **Create operations**: Use `checkMCPCreateScope(auth, targetDriveId)` before creating resources
   - Applies to: page creation, file uploads, drive creation
   - Scoped tokens CANNOT create new drives (targetDriveId === null returns 403)

4. **Multi-drive operations**: Use `filterDrivesByMCPScope(auth, driveIds)` to filter drive lists
   - Applies to: multi-drive search, activities across drives
   - Pass filtered IDs to subsequent database queries

### Implementation Pattern

```typescript
// Example: Page access with scope check
const auth = await authenticateRequestWithOptions(request, { allow: ['session', 'mcp'] });
if (isAuthError(auth)) return auth.error;

// CRITICAL: Check MCP token scope BEFORE any page access
const scopeError = await checkMCPPageScope(auth, pageId);
if (scopeError) return scopeError;

// Now proceed with normal authorization checks...
const canView = await canUserViewPage(auth.userId, pageId);
if (!canView) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
```

```typescript
// Example: Drive filtering for multi-drive search
const accessibleDriveIds = await getDriveIdsForUser(userId);

// CRITICAL: Filter by MCP token scope
const scopedDriveIds = filterDrivesByMCPScope(auth, accessibleDriveIds);

// Now use scopedDriveIds in database queries...
const drives = await db.select().from(drives)
  .where(inArray(drives.id, scopedDriveIds));
```

### Scope Check Decision Tree

| Operation Type | Scope Check Helper | When to Call |
|--------------|-------------------|--------------|
| Access a specific page | `checkMCPPageScope(auth, pageId)` | After auth, before permissions |
| Access a specific drive | `checkMCPDriveScope(auth, driveId)` | After auth, before operations |
| Create resource in drive | `checkMCPCreateScope(auth, driveId)` | After auth, before creation |
| Create new drive | `checkMCPCreateScope(auth, null)` | After auth, will deny scoped tokens |
| Filter drive list | `filterDrivesByMCPScope(auth, driveIds)` | After auth, before DB queries |
| Export from drive | `checkMCPDriveScope(auth, driveId)` | After auth, before export |

### Routes Fixed (2026-02-10)

The following hybrid routes now properly enforce MCP scope:

**Search:**
- `apps/web/src/app/api/search/multi-drive/route.ts` - Uses `filterDrivesByMCPScope()`

**Pages:**
- `apps/web/src/app/api/pages/tree/route.ts` - Uses `checkMCPDriveScope()`
- `apps/web/src/app/api/pages/[pageId]/export/markdown/route.ts` - Uses `checkMCPPageScope()`
- `apps/web/src/app/api/pages/[pageId]/export/docx/route.ts` - Uses `checkMCPPageScope()`
- `apps/web/src/app/api/pages/[pageId]/export/csv/route.ts` - Uses `checkMCPPageScope()`
- `apps/web/src/app/api/pages/[pageId]/export/xlsx/route.ts` - Uses `checkMCPPageScope()`
- `apps/web/src/app/api/pages/[pageId]/history/route.ts` - Uses `checkMCPPageScope()`
- `apps/web/src/app/api/pages/[pageId]/restore/route.ts` - Uses `checkMCPPageScope()`
- `apps/web/src/app/api/pages/[pageId]/versions/compare/route.ts` - Uses `checkMCPPageScope()`
- `apps/web/src/app/api/pages/[pageId]/agent-config/route.ts` - Uses `checkMCPPageScope()`
- `apps/web/src/app/api/pages/reorder/route.ts` - Uses `checkMCPPageScope()`

**Activities:**
- `apps/web/src/app/api/activities/route.ts` - Uses `checkMCPDriveScope()` and `checkMCPPageScope()`
- `apps/web/src/app/api/activities/export/route.ts` - Uses `checkMCPDriveScope()` and `checkMCPPageScope()`

**Upload:**
- `apps/web/src/app/api/upload/route.ts` - Uses `checkMCPCreateScope()`

**Drives:**
- `apps/web/src/app/api/drives/[driveId]/restore/route.ts` - Uses `checkMCPDriveScope()`
- `apps/web/src/app/api/drives/[driveId]/access/route.ts` - Uses `checkMCPDriveScope()`

**Search Routes (already compliant):**
- `apps/web/src/app/api/drives/[driveId]/search/regex/route.ts` - Uses `checkMCPDriveScope()`
- `apps/web/src/app/api/drives/[driveId]/search/glob/route.ts` - Uses `checkMCPDriveScope()`

**AI Routes (already compliant):**
- `apps/web/src/app/api/ai/chat/route.ts` - Uses `checkMCPPageScope()`
- `apps/web/src/app/api/ai/chat/messages/route.ts` - Uses `checkMCPPageScope()`

### Testing Strategy

When testing hybrid routes with MCP auth:
1. Test unscoped token access (allowedDriveIds: []) - should work like session
2. Test scoped token access within scope - should succeed
3. Test scoped token access outside scope - should return 403
4. Test scoped token trying to create drives - should return 403

All tests should verify that scope checks are called with the correct parameters and return appropriate 403 errors for out-of-scope access attempts.
