# Page View Architecture Pattern

## Overview

This document defines the architectural pattern for all page view components in PageSpace to prevent unnecessary component remounting and ensure smooth editing experiences.

## Problem Statement

### The Issue
When page view components receive the full `page` object as a prop from the tree, they are vulnerable to unnecessary remounting:

1. User edits content → auto-save triggers
2. Save completes → socket event fires
3. Tree revalidates → creates new `page` object reference
4. React sees new prop → unmounts/remounts component
5. Component cleanup runs → may trigger additional saves
6. Results in: flickering save indicators, disrupted editing, performance issues

### Root Cause
**Tight coupling between page tree state and active editor state.**

```typescript
// ❌ PROBLEMATIC PATTERN
<DocumentView page={page} />
// Every tree update creates new page object → remount
```

## Solution: PageId-Only Pattern

Page view components should:
- Only receive `pageId` (stable string) as prop
- Fetch and manage their own content independently
- Ignore tree updates completely while mounted
- Only reload on true navigation (pageId change)

```typescript
// ✅ CORRECT PATTERN
<DocumentView pageId={pageId} />
// Stable string reference → no unnecessary remounts
```

---

## Implementation Guide

### Step 1: Make useDocument (or equivalent hook) Self-Sufficient

**File:** `/hooks/useYourPageHook.ts`

Your page hook should be able to fetch its own content if not provided:

```typescript
export const useDocument = (pageId: string, initialContent?: string) => {
  const documentState = useDocumentState(pageId);
  const [isLoading, setIsLoading] = useState(false);

  // Initialize document on mount
  const initializeAndActivate = useCallback(async () => {
    // If initialContent provided, use it (optional optimization)
    if (initialContent !== undefined) {
      documentState.initializeDocument(initialContent);
      setActiveDocument(pageId);
      return;
    }

    // Otherwise, fetch content from API
    setIsLoading(true);
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}`);
      if (response.ok) {
        const page = await response.json();
        documentState.initializeDocument(page.content || '');
        setActiveDocument(pageId);
      }
    } catch (error) {
      console.error('Failed to fetch page content:', error);
      documentState.initializeDocument(''); // Fallback to empty
      setActiveDocument(pageId);
    } finally {
      setIsLoading(false);
    }
  }, [documentState, initialContent, setActiveDocument, pageId]);

  return {
    document: documentState.document,
    isLoading,
    initializeAndActivate,
    // ... other methods
  };
};
```

### Step 2: Refactor Page View Component

**File:** `/components/page-views/YourPageView.tsx`

#### 2.1 Update Props Interface

```typescript
// ❌ BEFORE
interface DocumentViewProps {
  page: TreePage;
}

// ✅ AFTER
interface DocumentViewProps {
  pageId: string;
}

const DocumentView = ({ pageId }: DocumentViewProps) => {
```

#### 2.2 Update Hook Usage

```typescript
// ❌ BEFORE
const {
  document: documentState,
  initializeAndActivate,
  // ...
} = useDocument(page.id, page.content);

// ✅ AFTER
const {
  document: documentState,
  isLoading, // Now provided by hook
  initializeAndActivate,
  // ...
} = useDocument(pageId); // No initial content - will fetch
```

#### 2.3 Replace All `page.id` References

Search for all occurrences of `page.id` and replace with `pageId`:

```typescript
// ❌ BEFORE
const componentId = `document-${page.id}`;
const response = await fetchWithAuth(`/api/pages/${page.id}`);

// ✅ AFTER
const componentId = `document-${pageId}`;
const response = await fetchWithAuth(`/api/pages/${pageId}`);
```

#### 2.4 Update Socket Event Handlers

```typescript
// ✅ CORRECT
const handleContentUpdate = async (eventData: PageEventPayload) => {
  if (eventData.socketId && eventData.socketId === socket.id) {
    return; // Ignore self-triggered events
  }

  if (eventData.pageId === pageId) { // Use pageId, not page.id
    // Fetch latest content...
  }
};
```

### Step 3: Update Parent Component (CenterPanel)

**File:** `/components/layout/middle-content/CenterPanel.tsx`

Update how view components are rendered:

```typescript
// ❌ BEFORE
const pageComponent = ViewComponent ? (
  <ViewComponent page={page} />
) : (
  <div>This page type is not supported.</div>
);

// ✅ AFTER
const pageComponent = ViewComponent ? (
  <ViewComponent pageId={page.id} /> // Pass only ID
) : (
  <div>This page type is not supported.</div>
);
```

---

## Pattern Checklist

When creating or refactoring a page view component:

### ✅ Component Props
- [ ] Component receives `pageId: string` only (not full page object)
- [ ] No dependency on tree state or page object shape

### ✅ Content Management
- [ ] Hook fetches its own content if not cached
- [ ] Hook provides loading state
- [ ] Content fetch happens in `useEffect` or initialization function
- [ ] Handles fetch errors gracefully (fallback to empty)

### ✅ State Independence
- [ ] Component state managed entirely by Zustand store (or equivalent)
- [ ] No props passed down that change with tree updates
- [ ] Component only remounts when `pageId` changes (true navigation)

### ✅ Event Handling
- [ ] Socket events filtered by `pageId` (not object reference)
- [ ] Self-triggered events ignored via socket ID
- [ ] Updates only applied when not dirty

### ✅ Cleanup
- [ ] Save on unmount uses ref pattern (not dependency)
- [ ] Cleanup only runs on TRUE unmount
- [ ] No saves triggered by effect re-runs

---

## Benefits

### 1. **Stability**
- Component only remounts on actual page navigation
- Tree updates don't affect active editor
- No flickering or disrupted editing

### 2. **Performance**
- Fewer unnecessary renders
- No cascade of remounts across components
- Better memory usage

### 3. **Maintainability**
- Clear separation of concerns
- Tree manages navigation, views manage content
- Easier to reason about state flow

### 4. **Scalability**
- Pattern works for any page type
- Easy to add new page views
- Consistent architecture across codebase

---

## Example: Document View Refactor

### Before
```typescript
interface DocumentViewProps {
  page: TreePage; // Full object with children, messages, etc.
}

const DocumentView = ({ page }: DocumentViewProps) => {
  const { document } = useDocument(page.id, page.content);

  // Problem: Every tree update creates new page reference
  // → Component remounts
  // → Cleanup runs
  // → Save indicator flickers
}
```

### After
```typescript
interface DocumentViewProps {
  pageId: string; // Stable string reference
}

const DocumentView = ({ pageId }: DocumentViewProps) => {
  const { document, isLoading } = useDocument(pageId);

  useEffect(() => {
    initializeAndActivate(); // Fetches if needed
  }, [initializeAndActivate]);

  // ✅ Component stays mounted during tree updates
  // ✅ Only remounts on navigation (pageId change)
  // ✅ Smooth editing experience
}
```

---

## Migration Strategy

When refactoring existing components:

1. **Phase 1**: Make hook self-sufficient (add fetch capability)
2. **Phase 2**: Update component to pageId-only
3. **Phase 3**: Update parent to pass pageId
4. **Phase 4**: Test thoroughly
5. **Phase 5**: Remove any workarounds (memoization, revalidation blocks)

## Related Components to Refactor

Using this pattern, refactor:
- [ ] DocumentView (priority)
- [ ] SheetView (priority)
- [ ] ChannelView
- [ ] FolderView
- [ ] CanvasPageView
- [ ] AiChatView
- [ ] FileViewer

---

## Anti-Patterns to Avoid

### ❌ Don't: Pass Full Objects
```typescript
<DocumentView page={page} /> // Creates coupling
```

### ❌ Don't: Rely on Tree for Content
```typescript
const content = page.content; // Breaks on tree updates
```

### ❌ Don't: Use Prop Content for State
```typescript
const [content, setContent] = useState(page.content); // Stale
```

### ✅ Do: Use PageId + Independent State
```typescript
<DocumentView pageId={pageId} />
// Component fetches and manages its own content
```

---

## Testing

Verify the pattern works correctly:

1. **Rapid Typing Test**: Type continuously without pausing
   - ✅ Should NOT see "🚨 Component unmounting" logs
   - ✅ Save indicator should stay "Unsaved" until you pause

2. **Background Save Test**: Type, pause, let save complete
   - ✅ Should see "Saved" after debounce completes
   - ✅ Tree revalidation should NOT cause remount

3. **Socket Event Test**: Trigger save from another client/session
   - ✅ Component should NOT remount
   - ✅ Content should update only if not dirty

4. **Navigation Test**: Switch between pages
   - ✅ Should see cleanup log on actual navigation
   - ✅ New page should mount fresh

---

## Questions?

If you encounter issues implementing this pattern:
1. Check that ALL `page.id` references are replaced with `pageId`
2. Verify hook fetches content if not provided
3. Confirm parent passes only `pageId` string
4. Test with React DevTools to see mount/unmount cycles

For architectural questions, consult the Frontend Architecture Expert agent.
