# How to Add a New Page Type

This comprehensive guide explains how to add a new page type to PageSpace using the centralized page type configuration system. Follow each step carefully to ensure your new page type integrates correctly with all subsystems.

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Overview of the Page Type System](#2-overview-of-the-page-type-system)
3. [Step-by-Step Implementation](#3-step-by-step-implementation)
4. [Capability-Specific Integrations](#4-capability-specific-integrations)
5. [Testing Requirements](#5-testing-requirements)
6. [Complete Implementation Checklist](#6-complete-implementation-checklist)
7. [Helper Functions Reference](#7-helper-functions-reference)
8. [Common Pitfalls](#8-common-pitfalls)
9. [Example: Complete KANBAN Implementation](#9-example-complete-kanban-implementation)

---

## 1. Prerequisites

Before adding a new page type, familiarize yourself with:

- **Component Architecture:** See [Component Organization Philosophy](../2.0-architecture/2.1-frontend/components.md)
- **Layout System:** See [Layout Architecture](../2.0-architecture/2.1-frontend/layout.md)
- **Coding Standards:** See [Development Standards](./coding-standards.md)
- **Database Patterns:** See [Database Architecture](../2.0-architecture/2.2-backend/database.md)

### Key Principles

- Use the **centralized configuration** pattern for consistency
- Follow the **"page" prop pattern** for view components (except DocumentView which uses `pageId`)
- Leverage **helper functions** instead of hardcoded type checks
- Add proper **TypeScript types** throughout

---

## 2. Overview of the Page Type System

### Core Files

| File | Purpose |
|------|---------|
| `packages/lib/src/enums.ts` | PageType enum definition |
| `packages/db/src/schema/core.ts` | PostgreSQL enum (line 5) |
| `packages/lib/src/page-types.config.ts` | Centralized configuration |
| `packages/lib/src/page-type-validators.ts` | Validation logic |
| `apps/web/src/components/common/PageTypeIcon.tsx` | Icon component |

### Existing Page Types

| Type | Description | Can Have Children | Supports AI | Supports Realtime |
|------|-------------|-------------------|-------------|-------------------|
| `FOLDER` | Hierarchical container | Yes | No | No |
| `DOCUMENT` | Rich text editor | No | No | Yes |
| `CHANNEL` | Team chat | No | No | Yes |
| `AI_CHAT` | AI conversation | No | Yes | Yes |
| `CANVAS` | Custom HTML/CSS | No | No | No |
| `FILE` | Uploaded files | No | No | No |
| `SHEET` | Spreadsheet | No | Yes | Yes |

---

## 3. Step-by-Step Implementation

### Step 1: Update the PageType Enum

**File:** `packages/lib/src/enums.ts`

```typescript
export enum PageType {
  FOLDER = 'FOLDER',
  DOCUMENT = 'DOCUMENT',
  CHANNEL = 'CHANNEL',
  AI_CHAT = 'AI_CHAT',
  CANVAS = 'CANVAS',
  FILE = 'FILE',
  SHEET = 'SHEET',
  KANBAN = 'KANBAN', // Add your new type
}
```

### Step 2: Update the Database Schema

**File:** `packages/db/src/schema/core.ts` (line 5)

```typescript
export const pageType = pgEnum('PageType', [
  'FOLDER',
  'DOCUMENT',
  'CHANNEL',
  'AI_CHAT',
  'CANVAS',
  'FILE',
  'SHEET',
  'KANBAN', // Add your new type
]);
```

**Generate and apply migration:**

```bash
pnpm db:generate
pnpm db:migrate
```

> **Important:** After generating the migration, review the SQL file in `packages/db/drizzle/` to ensure it correctly adds the enum value.

### Step 3: Add Page Type Configuration

**File:** `packages/lib/src/page-types.config.ts`

Add a complete configuration entry:

```typescript
[PageType.KANBAN]: {
  type: PageType.KANBAN,
  displayName: 'Kanban Board',
  description: 'Visual task management board',
  iconName: 'Layout', // Must be in PageTypeIcon iconMap
  emoji: '📋',
  capabilities: {
    canHaveChildren: false,      // Can contain child pages?
    canAcceptUploads: false,     // Can files be dropped on it?
    canBeConverted: false,       // Can convert to other types?
    supportsRealtime: true,      // Real-time collaboration?
    supportsVersioning: true,    // Version history?
    supportsAI: false,           // AI features enabled?
  },
  defaultContent: () => JSON.stringify({
    columns: [],
    cards: []
  }),
  allowedChildTypes: [],  // Which types can be children
  apiValidation: {
    optionalFields: ['columns', 'cards'],
    customValidation: (data) => {
      if (data.columns && !Array.isArray(data.columns)) {
        return { valid: false, error: 'columns must be an array' };
      }
      return { valid: true };
    }
  },
  uiComponent: 'KanbanView',     // Must match component name exactly
  layoutViewType: 'document',    // Layout style: 'document' | 'folder' | 'channel' | 'ai' | 'canvas'
},
```

### Step 4: Add Type-Specific Helper Function (Optional but Recommended)

**File:** `packages/lib/src/page-types.config.ts`

Add a helper function for type checking:

```typescript
export function isKanbanPage(type: PageType): boolean {
  return type === PageType.KANBAN;
}
```

> **Remember:** Export this function from `packages/lib/src/index.ts` and `packages/lib/src/client-safe.ts` if needed client-side.

### Step 5: Update Icon Mapping

**File:** `apps/web/src/components/common/PageTypeIcon.tsx`

If using a new Lucide icon:

```typescript
import {
  FileText,
  Folder,
  MessageSquare,
  Sparkles,
  Palette,
  FileIcon,
  Table,
  Layout, // Add your new icon
} from 'lucide-react';

const iconMap = {
  Folder,
  FileText,
  MessageSquare,
  Sparkles,
  Palette,
  FileIcon,
  Table,
  Layout, // Add to map
} as const;
```

### Step 6: Update Search Components (Critical - Often Missed!)

Two search components have hardcoded icon switches that **must** be updated:

**File:** `apps/web/src/components/search/GlobalSearch.tsx` (lines 33-50)

```typescript
const getPageIcon = (pageType?: string) => {
  switch (pageType) {
    case 'DOCUMENT':
      return <FileText className="h-4 w-4" />;
    case 'FOLDER':
      return <FolderOpen className="h-4 w-4" />;
    case 'CHANNEL':
      return <Hash className="h-4 w-4" />;
    case 'AI_CHAT':
      return <MessageSquare className="h-4 w-4" />;
    case 'CANVAS':
      return <Sparkles className="h-4 w-4" />;
    case 'SHEET':
      return <Table className="h-4 w-4" />;
    case 'KANBAN': // Add your new type
      return <Layout className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
};
```

**File:** `apps/web/src/components/search/InlineSearch.tsx` (lines 23-40)

Apply the same change to the `getPageIcon` function.

### Step 7: Create the View Component

**Location:** `apps/web/src/components/layout/middle-content/page-views/kanban/KanbanView.tsx`

Follow the standard component pattern:

```tsx
"use client";

import React, { useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { patch } from '@/lib/auth-fetch';
import { TreePage } from '@/hooks/usePageTree';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { useEditingStore } from '@/stores/useEditingStore';

interface KanbanViewProps {
  page: TreePage;  // Standard pattern - use TreePage from usePageTree
}

interface KanbanData {
  columns: Array<{ id: string; title: string }>;
  cards: Array<{ id: string; columnId: string; title: string }>;
}

const KanbanView = ({ page }: KanbanViewProps) => {
  const { setDocument, setSaveCallback } = useDocumentStore();

  // Parse content safely
  const parseContent = (content: string | undefined): KanbanData => {
    try {
      return content ? JSON.parse(content) : { columns: [], cards: [] };
    } catch {
      return { columns: [], cards: [] };
    }
  };

  const saveContent = useCallback(async (pageId: string, newValue: string) => {
    try {
      await patch(`/api/pages/${pageId}`, { content: newValue });
      toast.success('Kanban board saved!');
    } catch (error) {
      toast.error('Failed to save kanban board.');
    }
  }, []);

  // Initialize document store
  useEffect(() => {
    const initialContent = typeof page.content === 'string' ? page.content : '';
    setDocument(page.id, initialContent);
    setSaveCallback(saveContent);
  }, [page.id, page.content, setDocument, setSaveCallback, saveContent]);

  // Register editing state for UI refresh protection (see docs/3.0-guides-and-tools/ui-refresh-protection.md)
  useEffect(() => {
    return () => {
      useEditingStore.getState().endEditing(page.id);
    };
  }, [page.id]);

  const data = parseContent(page.content);

  return (
    <div className="h-full p-4">
      <div className="flex gap-4 overflow-x-auto h-full">
        {data.columns.map(column => (
          <div key={column.id} className="flex-shrink-0 w-72 bg-muted rounded-lg p-3">
            <h3 className="font-semibold mb-2">{column.title}</h3>
            <div className="space-y-2">
              {data.cards
                .filter(card => card.columnId === column.id)
                .map(card => (
                  <div key={card.id} className="bg-background p-3 rounded shadow-sm">
                    {card.title}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default KanbanView;
```

### Step 8: Update Component Maps (Two Files!)

**File:** `apps/web/src/components/layout/middle-content/CenterPanel.tsx` (lines 63-70)

```typescript
import KanbanView from './page-views/kanban/KanbanView';

const componentMap = {
  FolderView,
  AiChatView,
  ChannelView,
  DocumentView,
  CanvasPageView,
  FileViewer,
  SheetView,
  KanbanView, // Add your component
};
```

**File:** `apps/web/src/components/layout/middle-content/index.tsx` (lines 41-49)

Apply the same change. **Both files must stay in sync!**

### Step 9: Add to Create Page Dialog

**File:** `apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx` (lines 179-188)

```tsx
<SelectContent>
  <SelectItem value="DOCUMENT">Document</SelectItem>
  <SelectItem value="FOLDER">Folder</SelectItem>
  <SelectItem value="CHANNEL">Channel</SelectItem>
  <SelectItem value="AI_CHAT">AI Chat</SelectItem>
  <SelectItem value="CANVAS">Canvas</SelectItem>
  <SelectItem value="SHEET">Sheet</SelectItem>
  <SelectItem value="KANBAN">Kanban Board</SelectItem> {/* Add your type */}
  <SelectItem value="FILE">File Upload</SelectItem>
</SelectContent>
```

### Step 10: Add Validation Logic

**File:** `packages/lib/src/page-type-validators.ts`

Add a case in `validatePageCreation` (around line 77):

```typescript
case PageType.KANBAN:
  if (data.columns && !Array.isArray(data.columns)) {
    errors.push('columns must be an array');
  }
  if (data.cards && !Array.isArray(data.cards)) {
    errors.push('cards must be an array');
  }
  break;
```

Add a case in `validatePageUpdate` (around line 190):

```typescript
case PageType.KANBAN:
  if (typeof data.content === 'string') {
    try {
      const parsed = JSON.parse(data.content);
      if (parsed.columns && !Array.isArray(parsed.columns)) {
        errors.push('columns must be an array');
      }
    } catch {
      errors.push('Content must be valid JSON for kanban pages');
    }
  }
  break;
```

### Step 11: Update AI Content Parser (Critical for AI Features!)

**File:** `packages/lib/src/page-content-parser.ts`

Add a case in `getPageContentForAI` switch statement (around line 140):

```typescript
case PageType.KANBAN: {
  try {
    const kanbanData = page.content ? JSON.parse(page.content) : { columns: [], cards: [] };
    contentString += "Kanban Board Structure:\n";
    contentString += `Columns: ${kanbanData.columns?.length || 0}\n`;
    contentString += `Cards: ${kanbanData.cards?.length || 0}\n\n`;

    if (kanbanData.columns && kanbanData.columns.length > 0) {
      kanbanData.columns.forEach((col: any) => {
        contentString += `Column: ${col.title}\n`;
        const columnCards = kanbanData.cards?.filter((c: any) => c.columnId === col.id) || [];
        columnCards.forEach((card: any) => {
          contentString += `  - ${card.title}\n`;
        });
      });
    } else {
      contentString += "No columns defined.\n";
    }
  } catch (error) {
    contentString += `Failed to parse kanban content: ${error instanceof Error ? error.message : String(error)}\n`;
  }
  break;
}
```

> **Why this matters:** Without this case, AI tools like `read_page` won't be able to understand your page's content when providing context to the AI.

### Step 12: Update API Route Type Union

**File:** `apps/web/src/app/api/pages/route.ts` (lines 109-111, 123-125)

The API route has a hardcoded type union that TypeScript won't catch automatically:

```typescript
interface APIPageInsertData {
  title: string;
  type: 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'SHEET' | 'KANBAN'; // Add here
  // ...
}

// Also update line ~125:
type: type as 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'SHEET' | 'KANBAN',
```

---

## 4. Capability-Specific Integrations

### If `supportsRealtime: true`

Your component should listen for real-time updates via Socket.IO:

```typescript
import { useSocket } from '@/hooks/useSocket';
import { PageEventPayload } from '@/lib/socket-utils';

// In your component:
const socket = useSocket();

useEffect(() => {
  if (!socket) return;

  const handleContentUpdate = (payload: PageEventPayload) => {
    if (payload.pageId === page.id && payload.event === 'content_updated') {
      // Handle real-time update - refresh content from server or apply delta
    }
  };

  socket.on('page_event', handleContentUpdate);
  return () => { socket.off('page_event', handleContentUpdate); };
}, [socket, page.id]);
```

### If `supportsAI: true`

Consider adding AI-specific fields:

1. **Database fields** (already exist for AI_CHAT, reuse pattern):
   - `systemPrompt`, `enabledTools`, `aiProvider`, `aiModel`

2. **Validation** in `validatePageCreation`:
   ```typescript
   if (data.systemPrompt && typeof data.systemPrompt !== 'string') {
     errors.push('systemPrompt must be a string');
   }
   ```

3. **API route handling** for AI settings

### If the Type Should Support Exports

**File:** `apps/web/src/components/layout/middle-content/content-header/ExportDropdown.tsx`

Add export options:

```typescript
{pageType === 'KANBAN' && (
  <DropdownMenuItem onClick={() => handleExport('json')}>
    Export as JSON
  </DropdownMenuItem>
)}
```

Create the export API route if needed at:
`apps/web/src/app/api/pages/[pageId]/export/[format]/route.ts`

### If `canHaveChildren: true`

Your page type will appear in folder views. Ensure the sidebar tree can expand/collapse it properly (handled automatically by existing TreeNode component).

---

## 5. Testing Requirements

### Unit Tests

**File:** `packages/lib/src/__tests__/page-type-validators.test.ts`

Add comprehensive test cases:

```typescript
describe('KANBAN page type', () => {
  it('validates valid KANBAN creation', () => {
    const result = validatePageCreation(PageType.KANBAN, {
      title: 'Test Kanban'
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('validates KANBAN with valid columns and cards', () => {
    const result = validatePageCreation(PageType.KANBAN, {
      title: 'Test Kanban',
      columns: [{ id: '1', title: 'To Do' }],
      cards: [{ id: '1', columnId: '1', title: 'Task 1' }]
    });
    expect(result.valid).toBe(true);
  });

  it('rejects KANBAN with invalid columns type', () => {
    const result = validatePageCreation(PageType.KANBAN, {
      title: 'Test Kanban',
      columns: 'not-an-array'
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('columns must be an array');
  });
});
```

**File:** `packages/lib/src/__tests__/page-content-parser.test.ts`

Add content parsing tests:

```typescript
it('parses KANBAN page content correctly', () => {
  const page = {
    id: '1',
    title: 'Test Kanban',
    type: PageType.KANBAN,
    content: JSON.stringify({
      columns: [{ id: '1', title: 'To Do' }],
      cards: [{ id: '1', columnId: '1', title: 'Task 1' }]
    })
  };
  const result = getPageContentForAI(page as any);
  expect(result).toContain('Kanban Board Structure');
  expect(result).toContain('To Do');
  expect(result).toContain('Task 1');
});
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run specific test file
cd packages/lib && npx vitest run src/__tests__/page-type-validators.test.ts

# Run with watch mode
pnpm test:watch

# Run with coverage
pnpm test:coverage
```

### Manual Testing Checklist

1. Create a new page of your type via the Create Page Dialog
2. Verify the icon displays correctly in:
   - Sidebar tree (TreeNode)
   - Global search results
   - Inline search results
3. Verify content saves and loads correctly
4. Test validation by providing invalid data
5. Test the page in the AI chat context (ask AI about the page)

---

## 6. Complete Implementation Checklist

Use this checklist to ensure nothing is missed:

### Required (All Page Types)

- [ ] `packages/lib/src/enums.ts` - Add to PageType enum
- [ ] `packages/db/src/schema/core.ts` - Add to pgEnum (line 5)
- [ ] Run `pnpm db:generate && pnpm db:migrate`
- [ ] `packages/lib/src/page-types.config.ts` - Add full configuration entry
- [ ] `packages/lib/src/page-type-validators.ts` - Add case in `validatePageCreation`
- [ ] `packages/lib/src/page-type-validators.ts` - Add case in `validatePageUpdate`
- [ ] `packages/lib/src/page-content-parser.ts` - Add case in `getPageContentForAI`
- [ ] `apps/web/src/components/common/PageTypeIcon.tsx` - Add icon import and mapping (if new icon)
- [ ] `apps/web/src/components/search/GlobalSearch.tsx` - Add case in `getPageIcon` switch
- [ ] `apps/web/src/components/search/InlineSearch.tsx` - Add case in `getPageIcon` switch
- [ ] Create view component at `apps/web/src/components/layout/middle-content/page-views/[type]/[Type]View.tsx`
- [ ] `apps/web/src/components/layout/middle-content/CenterPanel.tsx` - Add import and componentMap entry
- [ ] `apps/web/src/components/layout/middle-content/index.tsx` - Add import and componentMap entry
- [ ] `apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx` - Add SelectItem
- [ ] `apps/web/src/app/api/pages/route.ts` - Add to type unions (lines ~111, ~125)

### Optional (Based on Capabilities)

- [ ] Add helper function `is[Type]Page()` in `page-types.config.ts`
- [ ] Export helper from `packages/lib/src/index.ts`
- [ ] Export helper from `packages/lib/src/client-safe.ts`
- [ ] Add real-time socket listeners (if `supportsRealtime: true`)
- [ ] Add AI configuration fields (if `supportsAI: true`)
- [ ] Add export functionality in `ExportDropdown.tsx` (if applicable)
- [ ] Register with `useEditingStore` for UI refresh protection

### Testing

- [ ] Add tests in `packages/lib/src/__tests__/page-type-validators.test.ts`
- [ ] Add tests in `packages/lib/src/__tests__/page-content-parser.test.ts`
- [ ] Manual test: Create page via dialog
- [ ] Manual test: Verify icon displays in sidebar tree
- [ ] Manual test: Verify icon displays in search results
- [ ] Manual test: Verify content saves and loads
- [ ] Manual test: Verify validation errors display correctly
- [ ] Manual test: Verify AI can read page content

### Build Verification

- [ ] `pnpm build` - No TypeScript errors
- [ ] `pnpm lint` - No linting errors
- [ ] `pnpm test` - All tests pass

---

## 7. Helper Functions Reference

Available from `@pagespace/lib` or `@pagespace/lib/client-safe`:

```typescript
// Configuration access
getPageTypeConfig(type: PageType): PageTypeConfig
getPageTypeIconName(type: PageType): string
getPageTypeEmoji(type: PageType): string
getPageTypeDisplayName(type: PageType): string
getPageTypeDescription(type: PageType): string
getPageTypeComponent(type: PageType): string
getLayoutViewType(type: PageType): string

// Capability checks
canPageTypeHaveChildren(type: PageType): boolean
canPageTypeAcceptUploads(type: PageType): boolean
canBeConverted(type: PageType): boolean
supportsAI(type: PageType): boolean
supportsRealtime(type: PageType): boolean
getAllowedChildTypes(type: PageType): PageType[]

// Content
getDefaultContent(type: PageType): any

// Type guards
isDocumentPage(type: PageType): boolean
isFilePage(type: PageType): boolean
isSheetPage(type: PageType): boolean
isFolderPage(type: PageType): boolean
isCanvasPage(type: PageType): boolean
isChannelPage(type: PageType): boolean
isAIChatPage(type: PageType): boolean
```

---

## 8. Common Pitfalls

### 1. Forgetting Database Migration

Always run migrations after updating the schema:
```bash
pnpm db:generate && pnpm db:migrate
```

### 2. Mismatched Component Names

The `uiComponent` value in config **must exactly match** your component name in the componentMap.

### 3. Missing Icon Mapping

If your `iconName` isn't in the PageTypeIcon's `iconMap`, you'll get a fallback icon.

### 4. Inconsistent Component Maps

Both `CenterPanel.tsx` and `index.tsx` have componentMaps that **must stay in sync**.

### 5. Search Components Not Updated

The `getPageIcon` functions in GlobalSearch.tsx and InlineSearch.tsx are **separate** from PageTypeIcon and need manual updates. This is often forgotten!

### 6. Invalid Default Content

Ensure `defaultContent()` returns JSON-serializable data. For structured content, return a stringified JSON object.

### 7. API Type Union Not Updated

The API route at `apps/web/src/app/api/pages/route.ts` has hardcoded type unions that TypeScript won't catch - update manually.

### 8. Missing Content Parser Case

If you don't add a case in `page-content-parser.ts`, AI tools won't understand your page's content and will show "Content extraction not implemented for page type: [TYPE]".

### 9. Component Interface Mismatch

Most view components use `{ page: TreePage }` as props. DocumentView is the exception using `{ pageId: string }`. Follow the standard pattern unless you have a specific reason.

### 10. Circular Dependencies

Be careful when importing from `@pagespace/lib` in `packages/lib` itself. Use relative imports within the package.

---

## 9. Example: Complete KANBAN Implementation

Here's a summary of all files to modify for a KANBAN page type:

| File | Changes |
|------|---------|
| `packages/lib/src/enums.ts` | +1 line |
| `packages/db/src/schema/core.ts` | +1 line |
| `packages/lib/src/page-types.config.ts` | +30 lines (config + helper) |
| `packages/lib/src/page-type-validators.ts` | +16 lines (2 cases) |
| `packages/lib/src/page-content-parser.ts` | +25 lines (1 case) |
| `packages/lib/src/index.ts` | +1 line (export helper) |
| `packages/lib/src/client-safe.ts` | +1 line (export helper) |
| `apps/web/src/components/common/PageTypeIcon.tsx` | +2 lines |
| `apps/web/src/components/search/GlobalSearch.tsx` | +2 lines |
| `apps/web/src/components/search/InlineSearch.tsx` | +2 lines |
| `apps/web/src/components/layout/middle-content/CenterPanel.tsx` | +2 lines |
| `apps/web/src/components/layout/middle-content/index.tsx` | +2 lines |
| `apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx` | +1 line |
| `apps/web/src/app/api/pages/route.ts` | +2 lines (type unions) |
| `apps/web/src/components/layout/middle-content/page-views/kanban/KanbanView.tsx` | NEW ~80 lines |
| `packages/lib/src/__tests__/page-type-validators.test.ts` | +25 lines |
| `packages/lib/src/__tests__/page-content-parser.test.ts` | +15 lines |

**Total: ~17 files modified, ~200 lines of code**

---

**Last Updated:** 2025-01-27
