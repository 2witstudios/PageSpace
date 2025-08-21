# How to Add a New Page Type

This guide explains how to add a new page type to the application. Page types define how the content in the middle panel is rendered.

## 1. Prerequisites

Before adding a new page type, you should be familiar with the following concepts:

-   **Component Architecture:** Understand how components are organized in the `/components` directory. See the [Component Organization Philosophy](../2.0-architecture/2.1-frontend/components.md) for more details.
-   **Layout System:** Understand the five-section layout and where to place new components. See the [Layout Architecture](../2.0-architecture/2.1-frontend/layout.md) for more details.

## 2. Overview of Page Types

Page types are defined by the `PageType` enum located in [`packages/lib/src/enums.ts`](packages/lib/src/enums.ts). Each value in this enum corresponds to a specific type of content view.

The rendering logic is handled in the `PageContent` component, found in [`apps/web/src/components/layout/middle-content/index.tsx`](apps/web/src/components/layout/middle-content/index.tsx). A `switch` statement on the `page.type` property determines which React component to render for the selected page.

### Existing Page Types

-   `FOLDER`: Displays content as a folder with child pages.
-   `DOCUMENT`: Renders a rich text editor for documents.
-   `CHANNEL`: For chat-like communication channels.
-   `AI_CHAT`: A view for interacting with an AI chat.
-   `CANVAS`: A canvas-based drawing/whiteboard interface.

## 3. Steps to Add a New Page Type

### Step 1: Create the View Component

First, create a new React component that will render the view for your new page type. Follow the existing structure and place your new component in a new directory inside [`apps/web/src/components/layout/middle-content/page-views/`](apps/web/src/components/layout/middle-content/page-views/).

For example, to create a "KANBAN" page type:

```tsx
// apps/web/src/components/layout/middle-content/page-views/kanban/KanbanView.tsx

import { Page } from "@pagespace/lib/client";

interface KanbanViewProps {
  page: Page;
}

const KanbanView = ({ page }: KanbanViewProps) => {
  return (
    <div className="h-full p-4">
      <h1 className="text-2xl font-bold mb-4">{page.title}</h1>
      {/* Your Kanban board implementation here */}
      <div>Kanban content for page: {page.id}</div>
    </div>
  );
};

export default KanbanView;
```

### Step 2: Update the `PageType` Enum

Add your new page type to the `PageType` enum in [`packages/lib/src/enums.ts`](packages/lib/src/enums.ts).

```typescript
// packages/lib/src/enums.ts

export enum PageType {
  FOLDER = 'FOLDER',
  DOCUMENT = 'DOCUMENT',
  CHANNEL = 'CHANNEL',
  AI_CHAT = 'AI_CHAT',
  CANVAS = 'CANVAS',
  KANBAN = 'KANBAN', // Add your new type here
}
```

### Step 3: Update the Database Schema

Add the new `PageType` to the `pageType` enum in [`packages/db/src/schema/core.ts`](packages/db/src/schema/core.ts).

```typescript
// packages/db/src/schema/core.ts

export const pageType = pgEnum('PageType', [
    'FOLDER',
    'DOCUMENT', 
    'CHANNEL',
    'AI_CHAT',
    'CANVAS',
    'KANBAN', // Add your new type here
]);
```

After updating the schema, you will need to generate and apply a new migration:

```bash
pnpm db:generate
pnpm db:migrate
```

### Step 4: Update the PageContent Component

Import your new component and add a `case` to the `switch` statement in the `PageContent` component ([`apps/web/src/components/layout/middle-content/index.tsx`](apps/web/src/components/layout/middle-content/index.tsx)).

```tsx
// apps/web/src/components/layout/middle-content/index.tsx

// Add import for your new component
import KanbanView from './page-views/kanban/KanbanView';

// In the PageContent component's switch statement:
switch (page.type) {
  case PageType.FOLDER:
    return <FolderView key={page.id} page={page} />;
  case PageType.AI_CHAT:
    return <AiChatView key={page.id} page={page} />;
  case PageType.CHANNEL:
    return <ChannelView key={page.id} page={page} />;
  case PageType.DOCUMENT:
    return <DocumentView key={page.id} page={page} />;
  case PageType.CANVAS:
    return <CanvasPageView key={page.id} page={page} />;
  case PageType.KANBAN: // Add your new case
    return <KanbanView key={page.id} page={page} />;
  default:
    return <div className="p-4">This page type is not supported.</div>;
}
```

### Step 5: Add to Create Page Dialog

Add your new page type to the dropdown in the create page dialog ([`apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx`](apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx)):

```tsx
// In the SelectContent component:
<SelectContent>
  <SelectItem value="DOCUMENT">Document</SelectItem>
  <SelectItem value="FOLDER">Folder</SelectItem>
  <SelectItem value="CHANNEL">Channel</SelectItem>
  <SelectItem value="AI_CHAT">AI Chat</SelectItem>
  <SelectItem value="CANVAS">Canvas</SelectItem>
  <SelectItem value="KANBAN">Kanban</SelectItem> {/* Add your new type */}
</SelectContent>
```

And handle initial content creation in the `handleSubmit` function:

```tsx
// In the handleSubmit function:
let content: Record<string, unknown> | string[] | string = {};
if (type === 'DOCUMENT') {
  content = '';
} else if (type === 'CHANNEL' || type === 'AI_CHAT') {
  content = { messages: [] };
} else if (type === 'CANVAS') {
  content = '';
} else if (type === 'KANBAN') {
  content = { boards: [], cards: [] }; // Your initial content structure
}
```

By following these steps, you can successfully integrate a new page type into the application.

## 4. Best Practices

-   **Keep View Components Simple:** The view component should be responsible for rendering the content of the page, not for fetching data. Data fetching should be handled by hooks, as described in the [Page State Management Architecture](../2.0-architecture/2.1-frontend/state-management.md) guide.
-   **Follow Naming Conventions:** Follow the naming conventions for directories and components, as described in the [File Naming Conventions](./naming-conventions.md) guide.
-   **Use Proper TypeScript Types:** Always import types from `@pagespace/lib/client` and define proper interfaces for your component props.
-   **Handle Content Structure:** Consider how your page type will store and retrieve content. Use appropriate data structures that can be serialized to/from the database.
-   **Add Proper Styling:** Use Tailwind CSS classes consistently with the existing design system. Consider responsive design and accessibility.
-   **Update Documentation:** After adding a new page type, be sure to update this guide and any other relevant documentation.

## 5. Database Migration

After updating the `pageType` enum in the database schema, you must generate and apply a migration:

```bash
# Generate a new migration file
pnpm db:generate

# Apply the migration to your database
pnpm db:migrate
```

The migration will add the new page type to the database enum, allowing pages to be created with your new type.

## 6. Testing Your New Page Type

After implementing your new page type:

1. **Create a new page** using the Create Page Dialog to ensure the new type appears in the dropdown
2. **Test rendering** by creating a page of your new type and verifying it displays correctly
3. **Test navigation** by ensuring you can navigate to and from pages of your new type
4. **Test content persistence** by adding content and verifying it saves and loads correctly

**Last Updated:** 2025-08-21