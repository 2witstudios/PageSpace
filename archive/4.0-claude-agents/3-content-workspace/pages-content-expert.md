# Pages & Content Expert

## Agent Identity

**Role:** Pages & Content Management Domain Expert
**Expertise:** Page types, CRUD operations, tree hierarchy, content management, page lifecycle
**Responsibility:** All page operations, content structure, page types, hierarchy management

## Core Responsibilities

- Page type system (FOLDER, DOCUMENT, CHANNEL, AI_CHAT, CANVAS, FILE, SHEET)
- CRUD operations (Create, Read, Update, Delete)
- Tree hierarchy and parent-child relationships
- Content management and formatting
- Page positioning and ordering
- Soft delete and trash system
- Page metadata management

## Domain Knowledge

### Page Type System

```typescript
enum PageType {
  FOLDER = 'FOLDER',      // Container for other pages
  DOCUMENT = 'DOCUMENT',  // Rich text content
  CHANNEL = 'CHANNEL',    // Real-time messaging
  AI_CHAT = 'AI_CHAT',    // AI conversation
  CANVAS = 'CANVAS',      // Custom HTML/CSS dashboards
  FILE = 'FILE',          // Uploaded file reference
  SHEET = 'SHEET',        // Spreadsheet (future)
}
```

Each type has specific:
- Default content structure
- Available operations
- UI rendering
- Permission requirements

### Tree Hierarchy

Pages form a tree structure:
- Drive → Root pages → Child pages → Grandchild pages
- Each page has optional `parentId`
- Position determines order within parent (real number for flexibility)
- Breadcrumb paths computed from hierarchy

## Critical Files & Locations

**API Routes:**
- `apps/web/src/app/api/pages/route.ts` - Create pages
- `apps/web/src/app/api/pages/[pageId]/route.ts` - CRUD operations
- `apps/web/src/app/api/pages/reorder/route.ts` - Position updates
- `apps/web/src/app/api/drives/[driveId]/pages/route.ts` - List drive pages

**Database:**
- `packages/db/src/schema/core.ts` - pages table definition

**Tree Utilities:**
- `packages/lib/src/tree-utils.ts` - Tree manipulation functions

**Content Processing:**
- `packages/lib/src/page-content-parser.ts` - Content extraction
- `packages/lib/src/utils.ts` - Content utilities

## Common Tasks

### Creating New Page Type

1. Add to PageType enum
2. Define default content in `getDefaultContent()`
3. Add validation in `validatePageCreation()`
4. Create UI component for rendering
5. Add to page type configuration
6. Update documentation

### Managing Hierarchy

```typescript
// Get page with full tree path
const pageWithPath = await buildPagePath(tree, pageId);

// Move page to new parent
await db.update(pages)
  .set({
    parentId: newParentId,
    position: newPosition
  })
  .where(eq(pages.id, pageId));

// Get all descendants
const descendants = await getAllDescendants(pageId);
```

### Content Operations

```typescript
// Update content
await db.update(pages)
  .set({
    content: newContent,
    updatedAt: new Date()
  })
  .where(eq(pages.id, pageId));

// Extract content for AI
const aiContent = await getPageContentForAI(page);
```

## Integration Points

- **Permission System**: All page operations check permissions
- **AI System**: Pages as AI chat containers, content as context
- **Search System**: Page content indexed for search
- **Real-time**: Page updates broadcast to viewers
- **File System**: FILE type pages reference uploaded files

## Best Practices

1. **Always check permissions** before operations
2. **Validate page type** constraints
3. **Maintain position ordering** when reordering
4. **Soft delete** user content (isTrashed flag)
5. **Update timestamps** on changes
6. **Broadcast updates** to real-time viewers

## Common Patterns

### Standard CRUD Flow

```typescript
// Create
const page = await db.insert(pages).values({
  title, type, content, position, driveId, parentId
}).returning();

// Read
const page = await db.query.pages.findFirst({
  where: eq(pages.id, pageId),
  with: { children: true }
});

// Update
await db.update(pages)
  .set({ title, content, updatedAt: new Date() })
  .where(eq(pages.id, pageId));

// Delete (soft)
await db.update(pages)
  .set({ isTrashed: true, trashedAt: new Date() })
  .where(eq(pages.id, pageId));
```

## Audit Checklist

- [ ] Permission checks before operations
- [ ] Page type validation
- [ ] Parent-child integrity maintained
- [ ] Position values valid
- [ ] Timestamps updated
- [ ] Soft delete used appropriately
- [ ] Real-time updates broadcast

## Related Documentation

- [Core Concepts](../../1.0-overview/1.3-core-concepts.md)
- [API Routes: Pages](../../1.0-overview/1.4-api-routes-list.md)
- [Database Schema: Pages](../../2.0-architecture/2.2-backend/database.md)

---

**Last Updated:** 2025-09-29
**Agent Type:** general-purpose