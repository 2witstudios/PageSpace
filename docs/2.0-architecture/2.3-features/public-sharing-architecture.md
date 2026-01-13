# Public Sharing Architecture Plan

## Executive Summary

This document scopes the architectural changes required to implement Google Drive-style public sharing for pages, drives, and AI conversations. The current system is **entirely user-authenticated** with no public access paths.

**Estimated Scope**: Medium-Large (touches auth, permissions, database, API routes, frontend)

---

## Current State Analysis

### What Exists Today

| Component | Status | Notes |
|-----------|--------|-------|
| Permission System | ✅ Centralized | `@pagespace/lib/permissions` with caching |
| Multi-Auth Support | ✅ Ready | JWT, MCP tokens already supported |
| Time-Limited Access | ✅ Schema exists | `pagePermissions.expiresAt` field |
| Read-Only Tool Filter | ✅ Implemented | `filterToolsForReadOnly()` exists |
| Public Access | ❌ None | Every route requires authentication |
| Share Links | ❌ None | No share token infrastructure |
| Anonymous Routes | ❌ None | No unauthenticated page views |

### Critical Architectural Constraint

The current `Layout.tsx` **forces authentication**:
```typescript
useEffect(() => {
  if (hasHydrated && !isLoading && !isAuthenticated) {
    router.push('/auth/signin');
  }
}, [hasHydrated, isLoading, isAuthenticated, router]);
```

Public routes must bypass the main application layout entirely.

---

## Proposed Architecture

### 1. Database Schema Additions

#### New Table: `shareLinks`

```typescript
// packages/db/src/schema/sharing.ts

export const shareLinks = pgTable('share_links', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // What is being shared
  resourceType: text('resourceType', {
    enum: ['page', 'drive', 'conversation']
  }).notNull(),
  resourceId: text('resourceId').notNull(),

  // Access token (cryptographically secure)
  token: text('token').unique().notNull(), // Use crypto.randomBytes(32).toString('base64url')

  // Access control
  accessLevel: text('accessLevel', {
    enum: ['view', 'comment', 'edit']
  }).notNull().default('view'),
  password: text('password'), // bcrypt hash if password-protected

  // Limits
  expiresAt: timestamp('expiresAt', { mode: 'date' }),
  maxViews: integer('maxViews'), // null = unlimited
  viewCount: integer('viewCount').notNull().default(0),

  // Metadata
  createdBy: text('createdBy').notNull().references(() => users.id),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  lastAccessedAt: timestamp('lastAccessedAt', { mode: 'date' }),
  isActive: boolean('isActive').notNull().default(true),

  // Optional customization
  customSlug: text('customSlug').unique(), // e.g., "my-project-roadmap"
  allowComments: boolean('allowComments').notNull().default(false),
});

// Indexes
export const shareLinkIndexes = {
  tokenIdx: index('share_links_token_idx').on(shareLinks.token),
  resourceIdx: index('share_links_resource_idx').on(shareLinks.resourceType, shareLinks.resourceId),
  slugIdx: index('share_links_slug_idx').on(shareLinks.customSlug),
};
```

#### Schema Migration for Existing Tables

```typescript
// Add to pages table
isPublic: boolean('isPublic').notNull().default(false),
publicAccessLevel: text('publicAccessLevel', { enum: ['view', 'comment'] }),

// Add to drives table
isPublic: boolean('isPublic').notNull().default(false),
publicAccessLevel: text('publicAccessLevel', { enum: ['view', 'comment'] }),

// Add to conversations table
isPublic: boolean('isPublic').notNull().default(false),
```

---

### 2. Authentication Layer Changes

#### File: `apps/web/src/lib/auth/index.ts`

Add new authentication method for share tokens:

```typescript
export type AuthMethod = 'jwt' | 'mcp' | 'share_token';

export interface ShareTokenAuth {
  type: 'share_token';
  shareLink: {
    id: string;
    resourceType: 'page' | 'drive' | 'conversation';
    resourceId: string;
    accessLevel: 'view' | 'comment' | 'edit';
  };
  // No userId - anonymous access
}

export async function authenticateShareToken(
  token: string
): Promise<ShareTokenAuth | null> {
  const share = await db.select()
    .from(shareLinks)
    .where(and(
      eq(shareLinks.token, token),
      eq(shareLinks.isActive, true),
      or(
        isNull(shareLinks.expiresAt),
        gt(shareLinks.expiresAt, new Date())
      ),
      or(
        isNull(shareLinks.maxViews),
        lt(shareLinks.viewCount, shareLinks.maxViews)
      )
    ))
    .limit(1);

  if (!share[0]) return null;

  // Increment view count
  await db.update(shareLinks)
    .set({
      viewCount: sql`${shareLinks.viewCount} + 1`,
      lastAccessedAt: new Date()
    })
    .where(eq(shareLinks.id, share[0].id));

  return {
    type: 'share_token',
    shareLink: {
      id: share[0].id,
      resourceType: share[0].resourceType,
      resourceId: share[0].resourceId,
      accessLevel: share[0].accessLevel,
    }
  };
}
```

---

### 3. Permission System Updates

#### File: `packages/lib/src/permissions/permissions.ts`

Add public access check functions:

```typescript
// New function for share link access
export async function getShareLinkAccess(
  token: string,
  resourceType: 'page' | 'drive' | 'conversation',
  resourceId: string
): Promise<AccessLevel | null> {
  const share = await db.select()
    .from(shareLinks)
    .where(and(
      eq(shareLinks.token, token),
      eq(shareLinks.resourceType, resourceType),
      eq(shareLinks.resourceId, resourceId),
      eq(shareLinks.isActive, true),
      // Check expiration and view limits...
    ))
    .limit(1);

  if (!share[0]) return null;

  return {
    canView: true,
    canEdit: share[0].accessLevel === 'edit',
    canShare: false, // Public users cannot share
    canDelete: false,
    isPublic: true,
  };
}

// Updated main function
export async function getUserAccessLevel(
  userId: string | null, // Now nullable for public access
  pageId: string,
  shareToken?: string
): Promise<AccessLevel | null> {
  // 1. Check share token first (supports anonymous)
  if (shareToken) {
    const shareAccess = await getShareLinkAccess(shareToken, 'page', pageId);
    if (shareAccess) return shareAccess;
  }

  // 2. Fall back to user-based permissions
  if (!userId) return null;

  // ... existing permission logic ...
}
```

---

### 4. API Route Structure

#### New Public API Routes (No Auth Required)

```
/api/public/pages/[token]              GET     Get page content via share token
/api/public/pages/[token]/children     GET     Get child pages (for notebooks)
/api/public/drives/[token]             GET     Get drive overview via share token
/api/public/drives/[token]/pages       GET     List pages in shared drive
/api/public/conversations/[token]      GET     Get conversation metadata
/api/public/conversations/[token]/messages  GET  Get conversation messages
/api/public/validate/[token]           GET     Validate token (check password requirement)
```

#### Share Management Routes (Auth Required)

```
/api/pages/[pageId]/share              POST    Create share link
/api/pages/[pageId]/share              GET     List existing share links
/api/pages/[pageId]/share/[shareId]    DELETE  Revoke share link
/api/pages/[pageId]/share/[shareId]    PATCH   Update share settings

/api/drives/[driveId]/share            POST    Create drive share link
/api/conversations/[convId]/share      POST    Create conversation share link
```

#### Example Public Route Implementation

```typescript
// apps/web/src/app/api/public/pages/[token]/route.ts

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;

  // Validate share token (no user auth needed)
  const share = await validateShareToken(token, 'page');
  if (!share) {
    return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });
  }

  // Check password if required
  const { searchParams } = new URL(request.url);
  const password = searchParams.get('password');
  if (share.password && !await verifyPassword(password, share.password)) {
    return NextResponse.json({ error: 'Password required' }, { status: 401 });
  }

  // Fetch page content
  const page = await db.select()
    .from(pages)
    .where(eq(pages.id, share.resourceId))
    .limit(1);

  if (!page[0]) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  // Return sanitized page data (no sensitive fields)
  return NextResponse.json({
    page: sanitizePageForPublic(page[0]),
    accessLevel: share.accessLevel,
  });
}
```

---

### 5. Frontend Architecture

#### New Route Group: `/share/[token]`

```
apps/web/src/app/
├── share/
│   ├── layout.tsx              # Minimal public layout (no sidebar)
│   ├── [token]/
│   │   ├── page.tsx            # Public page viewer
│   │   ├── loading.tsx
│   │   └── error.tsx
│   ├── drive/
│   │   └── [token]/
│   │       └── page.tsx        # Public drive viewer
│   └── conversation/
│       └── [token]/
│           └── page.tsx        # Public conversation viewer
```

#### Public Layout Component

```typescript
// apps/web/src/app/share/layout.tsx

export default function PublicShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      {/* Minimal header with PageSpace branding */}
      <header className="border-b px-4 py-2 flex items-center justify-between">
        <Link href="/" className="text-sm font-medium">PageSpace</Link>
        <Button variant="outline" size="sm" asChild>
          <Link href="/auth/signin">Sign in</Link>
        </Button>
      </header>

      {/* Content area - no sidebar */}
      <main className="container max-w-4xl mx-auto py-8">
        {children}
      </main>

      {/* Footer with "Create your own" CTA */}
      <footer className="border-t px-4 py-4 text-center text-sm text-muted-foreground">
        <Link href="/auth/signup" className="text-primary hover:underline">
          Create your own PageSpace
        </Link>
      </footer>
    </div>
  );
}
```

#### New Components Required

| Component | Purpose | Complexity |
|-----------|---------|------------|
| `PublicPageViewer.tsx` | Read-only page rendering | Medium |
| `PublicConversationViewer.tsx` | Read-only AI chat display | Medium |
| `PublicDriveViewer.tsx` | Browse shared drive pages | Medium |
| `ShareLinkModal.tsx` | Create/manage share links | Medium |
| `ShareLinkSettings.tsx` | Configure link options | Low |
| `PasswordPrompt.tsx` | Password input for protected links | Low |
| `ShareBanner.tsx` | "You're viewing a shared page" notice | Low |

---

### 6. AI Conversation Public Sharing Specifics

#### Constraints for Public AI Conversations

1. **Read-Only by Default**: No sending new messages
2. **Tool Results Hidden**: Sensitive tool outputs (file contents, etc.) filtered
3. **No Tool Execution**: Even if `comment` access, no tool calls
4. **Sanitized Content**: Filter any embedded credentials/tokens

#### Filter Function for Public Display

```typescript
// apps/web/src/lib/ai/public-sanitizer.ts

export function sanitizeMessagesForPublic(
  messages: Message[]
): PublicMessage[] {
  return messages.map(msg => ({
    id: msg.id,
    role: msg.role,
    content: sanitizeContent(msg.content),
    createdAt: msg.createdAt,
    // Exclude: toolCalls, toolResults, userId, etc.
  }));
}

function sanitizeContent(content: string): string {
  // Remove potential secrets
  return content
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[API_KEY_REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [TOKEN_REDACTED]')
    // ... other patterns
}
```

---

## Implementation Phases

### Phase 1: Foundation (Schema + Auth)
- [ ] Create `shareLinks` table schema
- [ ] Run migration
- [ ] Implement `authenticateShareToken()` function
- [ ] Add share token validation utilities
- [ ] Write unit tests for token validation

### Phase 2: Page Sharing (Core Feature)
- [ ] Create `/api/public/pages/[token]` route
- [ ] Create `/api/pages/[pageId]/share` management routes
- [ ] Update permission functions for share access
- [ ] Build public page viewer component
- [ ] Build share link creation modal
- [ ] Integrate share button into page header

### Phase 3: AI Conversation Sharing
- [ ] Create `/api/public/conversations/[token]` route
- [ ] Create message sanitization utilities
- [ ] Build public conversation viewer
- [ ] Add share option to conversation list
- [ ] Test read-only constraints

### Phase 4: Drive Sharing
- [ ] Create `/api/public/drives/[token]` routes
- [ ] Build public drive browser
- [ ] Handle nested page access within shared drives
- [ ] Permission inheritance for drive shares

### Phase 5: Polish & Security
- [ ] Rate limiting for public routes
- [ ] Analytics/view tracking
- [ ] Password protection UI
- [ ] Expiration warnings
- [ ] Share link revocation
- [ ] Audit logging

---

## Security Considerations

### Token Generation

```typescript
// Use cryptographically secure tokens
import { randomBytes } from 'crypto';

function generateShareToken(): string {
  return randomBytes(32).toString('base64url'); // 256-bit entropy
}
```

**NOT** CUID2 - it's predictable and not designed for security.

### Rate Limiting

```typescript
// Public routes need aggressive rate limiting
const publicRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: 'Too many requests, please try again later',
});
```

### Content Security

| Risk | Mitigation |
|------|------------|
| XSS in page content | Sanitize HTML, CSP headers |
| Credential exposure | Content filtering/redaction |
| Enumeration attacks | Non-sequential tokens |
| Token leakage | `Referrer-Policy: no-referrer` |
| Crawler indexing | `X-Robots-Tag: noindex` |

---

## Effort Estimation

| Component | Files Changed | New Files | Complexity |
|-----------|---------------|-----------|------------|
| Database Schema | 3 | 1 | Low |
| Auth Layer | 2 | 0 | Medium |
| Permission System | 2 | 0 | Medium |
| Public API Routes | 0 | 8 | Medium |
| Share Management API | 0 | 6 | Medium |
| Public Frontend Pages | 0 | 6 | Medium |
| Share UI Components | 0 | 6 | Medium |
| Tests | 0 | 8 | Medium |
| **Total** | **~7** | **~35** | **Medium-Large** |

### What We Get For Free

- ✅ Permission caching infrastructure
- ✅ Read-only tool filtering
- ✅ Message sanitization patterns
- ✅ Multi-auth support
- ✅ Time-limited access (expiresAt)
- ✅ Rate limiting infrastructure

### What Requires Net-New Work

- ❌ Share token generation/validation
- ❌ Public route handlers (bypass auth)
- ❌ Public UI components (no sidebar)
- ❌ Share link management UI
- ❌ Content sanitization for public display
- ❌ Password protection flow

---

## Summary

**Rewrite Required**: Minimal - this is additive architecture, not a rewrite.

The permission system, authentication layer, and API patterns are all **well-designed for extension**. Key factors:

1. **Centralized permissions** → Add one check for share tokens
2. **Multi-auth support** → Add `share_token` as new auth method
3. **Existing patterns** → Follow established API route conventions

**Biggest Architectural Changes**:
1. New database table for share links
2. New authentication path for anonymous access
3. New route group `/share/[token]` bypassing main layout
4. New public-safe components (no editing, no tools)

This is approximately **2-3 weeks of focused development** for a single engineer, or faster with parallel work on backend (API) and frontend (UI) simultaneously.
