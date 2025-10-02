# How to Add a New Page Type

This guide explains how to add a new page type to the application using the centralized page type configuration system.

## 1. Prerequisites

Before adding a new page type, you should be familiar with the following concepts:

-   **Component Architecture:** Understand how components are organized in the `/components` directory. See the [Component Organization Philosophy](../2.0-architecture/2.1-frontend/components.md) for more details.
-   **Layout System:** Understand the five-section layout and where to place new components. See the [Layout Architecture](../2.0-architecture/2.1-frontend/layout.md) for more details.
-   **Centralized Configuration:** The page type system uses a centralized configuration pattern for consistency and maintainability.

## 2. Overview of Page Types

Page types are centrally managed through:

- **Enum Definition:** `PageType` enum in [`packages/lib/src/enums.ts`](packages/lib/src/enums.ts)
- **Configuration:** `PAGE_TYPE_CONFIGS` in [`packages/lib/src/page-types.config.ts`](packages/lib/src/page-types.config.ts)
- **Validation:** `page-type-validators.ts` for creation and update validation
- **Icon Component:** `PageTypeIcon` in [`apps/web/src/components/common/PageTypeIcon.tsx`](apps/web/src/components/common/PageTypeIcon.tsx)

The system automatically handles component selection, icon mapping, default content, and validation based on the centralized configuration.

### Existing Page Types

-   `FOLDER`: Displays content as a folder with child pages
-   `DOCUMENT`: Renders a rich text editor for documents
-   `CHANNEL`: For chat-like communication channels
-   `AI_CHAT`: A view for interacting with an AI chat
-   `CANVAS`: A canvas-based drawing/whiteboard interface
-   `FILE`: Uploaded files with metadata

## 3. Steps to Add a New Page Type

### Step 1: Update the `PageType` Enum

Add your new page type to the `PageType` enum in [`packages/lib/src/enums.ts`](packages/lib/src/enums.ts).

```typescript
// packages/lib/src/enums.ts

export enum PageType {
  FOLDER = 'FOLDER',
  DOCUMENT = 'DOCUMENT',
  CHANNEL = 'CHANNEL',
  AI_CHAT = 'AI_CHAT',
  CANVAS = 'CANVAS',
  FILE = 'FILE',
  KANBAN = 'KANBAN', // Add your new type here
}
```

### Step 2: Update the Database Schema

Add the new `PageType` to the `pageType` enum in [`packages/db/src/schema/core.ts`](packages/db/src/schema/core.ts).

```typescript
// packages/db/src/schema/core.ts

export const pageType = pgEnum('PageType', [
    'FOLDER',
    'DOCUMENT', 
    'CHANNEL',
    'AI_CHAT',
    'CANVAS',
    'FILE',
    'KANBAN', // Add your new type here
]);
```

After updating the schema, generate and apply a new migration:

```bash
pnpm db:generate
pnpm db:migrate
```

### Step 3: Add Configuration Entry

Add your new page type configuration to [`packages/lib/src/page-types.config.ts`](packages/lib/src/page-types.config.ts):

```typescript
// packages/lib/src/page-types.config.ts

export const PAGE_TYPE_CONFIGS: Record<PageType, PageTypeConfig> = {
  // ... existing configs ...
  
  [PageType.KANBAN]: {
    type: PageType.KANBAN,
    displayName: 'Kanban Board',
    description: 'Visual task management board',
    iconName: 'Layout', // Choose from available Lucide icons
    emoji: '📋',
    capabilities: {
      canHaveChildren: false,
      canAcceptUploads: false,
      canBeConverted: false,
      supportsRealtime: true,
      supportsVersioning: true,
      supportsAI: false,
    },
    defaultContent: () => JSON.stringify({ 
      columns: [], 
      cards: [] 
    }),
    allowedChildTypes: [],
    apiValidation: {
      optionalFields: ['columns', 'cards'],
      customValidation: (data) => {
        // Add custom validation logic if needed
        return { valid: true };
      }
    },
    uiComponent: 'KanbanView', // Must match your component name
    layoutViewType: 'document', // or 'folder', 'channel', 'ai', 'canvas'
  },
};
```

### Step 4: Add Icon Mapping (if using new icon)

If you're using a new Lucide icon not already in the icon map, update [`apps/web/src/components/common/PageTypeIcon.tsx`](apps/web/src/components/common/PageTypeIcon.tsx):

```typescript
// apps/web/src/components/common/PageTypeIcon.tsx

import { 
  FileText, 
  Folder, 
  MessageSquare, 
  Sparkles, 
  Palette, 
  FileIcon,
  Layout // Add your new icon import
} from 'lucide-react';

// Map icon names to actual icon components
const iconMap = {
  Folder,
  FileText,
  MessageSquare,
  Sparkles,
  Palette,
  FileIcon,
  Layout, // Add to the map
} as const;
```

### Step 5: Create the View Component

Create a new React component that will render the view for your new page type. Place it in [`apps/web/src/components/layout/middle-content/page-views/`](apps/web/src/components/layout/middle-content/page-views/):

```tsx
// apps/web/src/components/layout/middle-content/page-views/kanban/KanbanView.tsx

import { Page } from "@pagespace/lib/client";

interface KanbanViewProps {
  page: Page;
}

const KanbanView = ({ page }: KanbanViewProps) => {
  // Parse the content
  const content = page.content ? JSON.parse(page.content) : { columns: [], cards: [] };
  
  return (
    <div className="h-full p-4">
      <h1 className="text-2xl font-bold mb-4">{page.title}</h1>
      {/* Your Kanban board implementation here */}
      <div className="grid grid-cols-3 gap-4">
        {/* Render columns and cards */}
      </div>
    </div>
  );
};

export default KanbanView;
```

### Step 6: Update Component Map

Add your new component to the component map in both:
- [`apps/web/src/components/layout/middle-content/index.tsx`](apps/web/src/components/layout/middle-content/index.tsx)
- [`apps/web/src/components/layout/middle-content/CenterPanel.tsx`](apps/web/src/components/layout/middle-content/CenterPanel.tsx)

```tsx
// apps/web/src/components/layout/middle-content/index.tsx

import KanbanView from './page-views/kanban/KanbanView';

// In the PageContent component:
const componentMap = {
  FolderView,
  AiChatView,
  ChannelView,
  DocumentView,
  CanvasPageView,
  FileViewer,
  KanbanView, // Add your new component
};
```

### Step 7: Add to Create Page Dialog

Add your new page type to the dropdown in [`apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx`](apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx):

```tsx
// In the SelectContent component:
<SelectContent>
  <SelectItem value="DOCUMENT">Document</SelectItem>
  <SelectItem value="FOLDER">Folder</SelectItem>
  <SelectItem value="CHANNEL">Channel</SelectItem>
  <SelectItem value="AI_CHAT">AI Chat</SelectItem>
  <SelectItem value="CANVAS">Canvas</SelectItem>
  <SelectItem value="KANBAN">Kanban Board</SelectItem> {/* Add your new type */}
</SelectContent>
```

The initial content will be automatically handled by the `getDefaultContent()` function from your configuration.

### Step 8: Add Validation (Optional)

If your page type requires special validation, update [`packages/lib/src/page-type-validators.ts`](packages/lib/src/page-type-validators.ts):

```typescript
// In validatePageCreation function's switch statement:
case PageType.KANBAN:
  // Validate Kanban-specific fields
  if (data.columns && !Array.isArray(data.columns)) {
    errors.push('columns must be an array');
  }
  if (data.cards && !Array.isArray(data.cards)) {
    errors.push('cards must be an array');
  }
  break;
```

## 4. Benefits of the Centralized System

The centralized page type configuration provides:

- **Single Source of Truth:** All page type metadata in one place
- **Automatic Icon Mapping:** No need to manually handle icons in multiple places
- **Consistent Default Content:** Centralized default content generation
- **Type Safety:** TypeScript ensures all page types are properly configured
- **Reduced Duplication:** No need to update switch statements in multiple files
- **Easy Extension:** Adding a new page type requires minimal changes

## 5. Testing Your New Page Type

After implementing your new page type:

1. **Build the application** to ensure TypeScript compilation succeeds:
   ```bash
   pnpm build
   ```

2. **Run linting** to catch any issues:
   ```bash
   pnpm lint
   ```

3. **Create a new page** using the Create Page Dialog to ensure the new type appears

4. **Test rendering** by creating a page of your new type and verifying it displays correctly

5. **Test icon display** in the page tree and other locations

6. **Test content persistence** by adding content and verifying it saves and loads correctly

7. **Test validation** by attempting to create pages with invalid data

## 6. Helper Functions Available

The centralized system provides several helper functions you can use:

```typescript
import { 
  getPageTypeConfig,      // Get full config for a type
  getPageTypeIconName,    // Get icon name for a type
  getPageTypeEmoji,       // Get emoji for a type
  canPageTypeHaveChildren, // Check if type can have children
  getDefaultContent,      // Get default content for a type
  getPageTypeComponent,   // Get component name for a type
  getLayoutViewType,      // Get layout view type
  isDocumentPage,         // Check if type is DOCUMENT
  isFilePage,            // Check if type is FILE
  isFolderPage,          // Check if type is FOLDER
  isCanvasPage,          // Check if type is CANVAS
  isChannelPage,         // Check if type is CHANNEL
  isAIChatPage,          // Check if type is AI_CHAT
  supportsAI             // Check if type supports AI
} from '@pagespace/lib';
```

## 7. Common Pitfalls to Avoid

- **Forgetting database migration:** Always generate and apply migrations after updating the schema
- **Mismatched component names:** Ensure `uiComponent` in config matches your actual component name
- **Missing icon mapping:** If using a new icon, add it to the iconMap in PageTypeIcon.tsx
- **Invalid default content:** Ensure defaultContent returns valid JSON-serializable data
- **Circular dependencies:** Be careful when importing from @pagespace/lib in packages/lib itself

## 8. Example: Complete Implementation

Here's a complete example of adding a "TIMELINE" page type:

1. **Update enum** (`packages/lib/src/enums.ts`):
   ```typescript
   TIMELINE = 'TIMELINE'
   ```

2. **Update database** (`packages/db/src/schema/core.ts`):
   ```typescript
   'TIMELINE'
   ```

3. **Add configuration** (`packages/lib/src/page-types.config.ts`):
   ```typescript
   [PageType.TIMELINE]: {
     type: PageType.TIMELINE,
     displayName: 'Timeline',
     description: 'Chronological event timeline',
     iconName: 'Clock',
     emoji: '⏰',
     capabilities: {
       canHaveChildren: false,
       canAcceptUploads: false,
       canBeConverted: false,
       supportsRealtime: false,
       supportsVersioning: true,
       supportsAI: false,
     },
     defaultContent: () => JSON.stringify({ events: [] }),
     allowedChildTypes: [],
     uiComponent: 'TimelineView',
     layoutViewType: 'document',
   }
   ```

4. **Create component** (`apps/web/src/components/layout/middle-content/page-views/timeline/TimelineView.tsx`)

5. **Update component maps** in index.tsx and CenterPanel.tsx

6. **Add to Create Page Dialog**

7. **Run migrations and test**

**Last Updated:** 2025-01-02