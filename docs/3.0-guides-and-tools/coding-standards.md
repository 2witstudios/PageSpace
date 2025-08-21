# Development Standards

### Code Quality Principles
- **No `any` types** - Always use proper TypeScript types
- **Explicit over implicit** - Clear, self-documenting code
- **Right-first approach** - Build the ideal solution from the start
- **Consistent patterns** - Follow established conventions throughout

### Component Design Patterns
- **Composition over inheritance** - Build complex UI from simple parts
- **Props interfaces** - Explicit component contracts
- **Error boundaries** - Graceful failure handling
- **Accessibility first** - ARIA labels, keyboard navigation

### Contributor Pitfalls & Best Practices

#### 1. Message Content Handling
*Why: The `parts` array ensures that all content, whether plain text, rich text, or a file attachment, is handled consistently by the rendering system. This prevents UI bugs and simplifies the addition of new content types in the future.*
```typescript
// ❌ WRONG - Don't use plain strings for message content
const message = {
  content: "Hello world"  // Raw string content
};

// ✅ CORRECT - Always use message parts structure
const message = {
  parts: [
    { type: 'text', text: "Hello world" }
  ]
};

// ✅ CORRECT - For rich text content
const message = {
  parts: [
    { type: 'rich-text', content: richlineContent }
  ]
};
```

#### 2. Permission Logic Location
*Why: Centralizing permission logic in `@pagespace/lib/permissions` ensures that access control is consistent and easy to audit. Scattering permission checks across different API routes makes the system vulnerable to security holes and difficult to maintain. See the [RBAC & Permissions documentation](../2.0-architecture/2.2-backend/permissions.md) for more details.*
```typescript
// ❌ WRONG - Don't write permission logic anywhere else
// apps/web/src/api/pages/[pageId]/route.ts
const canEdit = user.id === page.ownerId; // Scattered logic

// ✅ CORRECT - Always use centralized permission utilities
import { getUserAccessLevel, canUserEditPage } from '@pagespace/lib/permissions';
const accessLevel = await getUserAccessLevel(userId, pageId);
const canEdit = canUserEditPage(accessLevel);
```

#### 3. Richline Content Usage
*Why: Directly rendering user-generated content can be unsafe. Always ensure that content is properly sanitized before rendering.*
```typescript
// ✅ CORRECT - Wrap in rich-text message part
const parts = convertToMessageParts(richlineContent, true);
return renderMessageParts(parts);
```

#### 4. Database Access Patterns
*Why: All database interactions must go through the `@pagespace/db` package. This ensures that all queries use the same Drizzle client and that the schema is consistent. Bypassing this package can lead to inconsistent data and makes it impossible to manage schema migrations centrally.*
```typescript
// ❌ WRONG - Don't access database outside @pagespace/db
import { Pool } from 'pg';
const client = new Pool(); // Direct database access

// ✅ CORRECT - Always use Drizzle client from @pagespace/db
import { db, pages } from '@pagespace/db';
const page = await db.select().from(pages);
```

#### 5. Next.js 15 Route Handlers
*Why: Next.js 15 introduced a breaking change where dynamic route parameters are now `Promise` objects. You must `await` the `context.params` object before accessing the parameters. Failing to do so will result in a runtime error. For more details, refer to the [Next.js App Router integration guide](../2.0-architecture/2.5-integrations/nextjs-app-router.md).*
```typescript
// ❌ WRONG - Old Next.js patterns
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params; // Params is now a Promise!
}

// ✅ CORRECT - Next.js 15 async params
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params; // Must await params
  return Response.json({ id });
}
```

#### 6. Mention System Usage
*Why: The mention system relies on a specific data structure to correctly render mentions and provide hover-card information. Using the `MentionData` type ensures that all necessary data is present and that mentions are handled consistently across the application.*
```typescript
// ❌ WRONG - Creating mentions without proper typing
const mention = {
  type: 'page',
  id: pageId,
  // Missing required data structure
};

// ✅ CORRECT - Use proper mention types
import type { MentionData } from '@/types/mentions';
const mention: MentionData = {
  type: 'page',
  id: pageId,
  data: {
    title: page.title,
    // Complete data structure
  }
};
```

### Performance Anti-Patterns

#### State Management
```typescript
// ❌ WRONG - Recreating context unnecessarily
const value = {
  user: user,
  setUser: setUser,
}; // New object on every render

// ✅ CORRECT - Memoize context values
const value = useMemo(() => ({
  user,
  setUser,
}), [user]);
```

#### Database Queries
```typescript
// ❌ WRONG - N+1 query problems
for (const page of pages) {
  const messages = await db.select().from(chatMessages).where(eq(chatMessages.pageId, page.id));
}

// ✅ CORRECT - Use relations or batch queries
const pagesWithMessages = await db.select().from(pages).leftJoin(chatMessages, eq(pages.id, chatMessages.pageId));
**Last Updated:** 2025-08-13