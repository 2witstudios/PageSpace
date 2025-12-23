# Document Preview for Tool Call Dropdowns

## Overview

Design specification for rich text document previews in AI tool call dropdowns. This replaces the current technical JSON/code output with user-friendly rich text rendering that matches the document editor experience.

## Problem Statement

The current tool call UI (`ToolCallRenderer.tsx`) displays technical output:
- **JSON parameters** shown in code blocks
- **Document content** displayed as syntax-highlighted code with line numbers
- **No visual preview** of how content will actually appear in the editor
- **No diff visualization** for content modifications

This is confusing for non-technical users who expect to see their documents rendered as they would appear in the editor.

## Goals

1. **Rich text previews** for document creation tools (create_page, read_page)
2. **Rich text diff viewer** for content modification tools (replace_lines)
3. **Clickable navigation** to created/modified pages
4. **Compact mode support** for sidebar display
5. **Extensible architecture** for future tool-specific renderers

---

## Design Decisions

Based on review:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **View toggle** | Yes - Code/Rich toggle | Match document page UX |
| **Preview size** | Fixed ~816×400px (print page width) | Hard truncate, no expand |
| **Component reuse** | Reuse `RichEditor` + `MonacoEditor` | No new lightweight components |
| **Lazy loading** | Yes - `React.lazy()` + Suspense | TipTap/Monaco are expensive |
| **Diff granularity** | Character-level | Better for typo fixes in rich text |

---

## Component Architecture

```
apps/web/src/components/ai/shared/chat/tool-calls/
├── ToolCallRenderer.tsx          # Main orchestrator (existing)
├── CompactToolCallRenderer.tsx   # Sidebar version (existing)
├── DocumentRenderer.tsx          # Code/text display (existing, keep for non-documents)
├── FileTreeRenderer.tsx          # Page hierarchy (existing)
├── TaskRenderer.tsx              # Task management (existing)
│
├── previews/                     # NEW: Document preview components
│   ├── DocumentPreviewContainer.tsx  # Wrapper with view toggle + lazy loading
│   ├── RichTextDiff.tsx              # Side-by-side diff with char-level highlighting
│   ├── CreatePagePreview.tsx         # create_page tool renderer
│   ├── ReadPagePreview.tsx           # read_page tool renderer
│   ├── ReplaceContentPreview.tsx     # replace_lines tool renderer
│   └── PageLink.tsx                  # Clickable page navigation component
```

---

## Component Specifications

### 1. DocumentPreviewContainer

The main wrapper that handles view toggle and lazy loading of editors.

```typescript
interface DocumentPreviewContainerProps {
  content: string;           // HTML content
  title: string;
  pageId?: string;
  driveId?: string;
  showNavigation?: boolean;  // Show "Open Page" link
  className?: string;
}
```

**Key features:**
- **View toggle**: Rich/Code buttons matching document page toolbar
- **Lazy loading**: Uses `React.lazy()` to defer RichEditor/MonacoEditor loading
- **Fixed dimensions**: 816px width (US Letter), 400px max height with hard truncate
- **Loading skeleton**: Shows placeholder while editors load

**Implementation approach:**
```tsx
const LazyRichEditor = React.lazy(() => import('@/components/editors/RichEditor'));
const LazyMonacoEditor = React.lazy(() => import('@/components/editors/MonacoEditor'));

const DocumentPreviewContainer: React.FC<DocumentPreviewContainerProps> = ({
  content,
  title,
  pageId,
  driveId,
  showNavigation = true
}) => {
  const [viewMode, setViewMode] = useState<'rich' | 'code'>('rich');

  return (
    <div className="rounded-md border bg-card overflow-hidden" style={{ maxWidth: 816 }}>
      {/* Header with title and view toggle */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          <span className="font-medium text-sm truncate">{title}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant={viewMode === 'rich' ? 'secondary' : 'ghost'}
                  onClick={() => setViewMode('rich')}>Rich</Button>
          <Button size="sm" variant={viewMode === 'code' ? 'secondary' : 'ghost'}
                  onClick={() => setViewMode('code')}>Code</Button>
        </div>
      </div>

      {/* Content area with lazy-loaded editor */}
      <div className="h-[400px] overflow-hidden">
        <Suspense fallback={<PreviewSkeleton />}>
          {viewMode === 'rich' ? (
            <LazyRichEditor value={content} readOnly onChange={() => {}} onEditorChange={() => {}} />
          ) : (
            <LazyMonacoEditor value={content} readOnly language="html" />
          )}
        </Suspense>
      </div>

      {/* Footer with navigation */}
      {showNavigation && pageId && driveId && (
        <div className="px-3 py-2 border-t">
          <PageLink pageId={pageId} driveId={driveId} title={title} />
        </div>
      )}
    </div>
  );
};
```

### 2. RichTextDiff

Visual diff viewer for rich text content changes with **character-level** highlighting.

```typescript
interface RichTextDiffProps {
  before: string;            // Original HTML content
  after: string;             // Modified HTML content
  mode?: 'side-by-side' | 'inline';
  title?: string;
  pageId?: string;
  driveId?: string;
}
```

**Display modes:**

| Mode | Description | Use Case |
|------|-------------|----------|
| `side-by-side` | Two columns with char-level highlights | Default, clear comparison |
| `inline` | Single view with `<del>`/`<ins>` markers | Compact, small changes |

**Character-level diff approach:**
1. Extract plain text from HTML (strip tags, preserve structure)
2. Use `diff-match-patch` or `jsdiff` library for character-level diffing
3. Map diff results back to highlight spans in rich text view
4. Highlight deleted chars in red, added chars in green

```tsx
const RichTextDiff: React.FC<RichTextDiffProps> = ({ before, after, mode = 'side-by-side', title }) => {
  // Compute character-level diff
  const diffs = useMemo(() => diffChars(stripHtml(before), stripHtml(after)), [before, after]);

  // For side-by-side: render both with lazy-loaded editors
  if (mode === 'side-by-side') {
    return (
      <div className="rounded-md border bg-card overflow-hidden" style={{ maxWidth: 816 }}>
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b">
          <GitCompare className="h-4 w-4" />
          <span className="font-medium text-sm">{title || 'Content Changes'}</span>
        </div>
        <div className="grid grid-cols-2 divide-x h-[400px]">
          <div className="overflow-hidden">
            <div className="text-xs text-muted-foreground px-2 py-1 bg-red-50 dark:bg-red-950/30 border-b">
              Before
            </div>
            <Suspense fallback={<PreviewSkeleton />}>
              <LazyRichEditor value={before} readOnly onChange={() => {}} onEditorChange={() => {}} />
            </Suspense>
          </div>
          <div className="overflow-hidden">
            <div className="text-xs text-muted-foreground px-2 py-1 bg-green-50 dark:bg-green-950/30 border-b">
              After
            </div>
            <Suspense fallback={<PreviewSkeleton />}>
              <LazyRichEditor value={after} readOnly onChange={() => {}} onEditorChange={() => {}} />
            </Suspense>
          </div>
        </div>
      </div>
    );
  }

  // Inline mode: single view with strikethrough/highlight
  // ... inline implementation
};
```

**Diff highlighting in Monaco (code view):**
For code view, Monaco has built-in diff support via `MonacoDiffEditor` which can be used as an alternative.

### 3. PageLink

Clickable component for navigating to pages.

```typescript
interface PageLinkProps {
  pageId: string;
  driveId: string;
  title: string;
  type: string;
  className?: string;
}
```

**Features:**
- Shows page icon based on type
- Navigates to `/dashboard/{driveId}/{pageId}` on click
- Hover state shows "Open page" tooltip
- External link icon indicator

### 4. CreatePagePreview

Specialized renderer for `create_page` tool results.

```typescript
// Renders when: toolName === 'create_page' && output.success
```

**Layout:**
```
┌─────────────────────────────────────────────────┐
│ ✓ Created "Meeting Notes"                       │
│   📄 Document in /Projects                      │
│                                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ [Rich text preview of initial content]      │ │
│ │                                             │ │
│ │ This is the document content rendered       │ │
│ │ exactly as it appears in the editor...      │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ [Open Page →]                                   │
└─────────────────────────────────────────────────┘
```

**Data requirements:**
The `create_page` tool output needs to include the created content. Current output:
```typescript
{
  success: boolean;
  id: string;
  title: string;
  type: string;
  parentId: string;
  message: string;
  // NEEDED: content: string; // The HTML content that was created
}
```

### 5. ReadPagePreview

Specialized renderer for `read_page` tool results.

```typescript
// Renders when: toolName === 'read_page' && output.success
```

**Layout:**
```
┌─────────────────────────────────────────────────┐
│ 📄 "Meeting Notes"                              │
│   Document • 42 lines • 1,234 chars             │
│                                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ [Rich text preview of page content]         │ │
│ │                                             │ │
│ │ # Heading                                   │ │
│ │ This is the document content...             │ │
│ │ • List item 1                               │ │
│ │ • List item 2                               │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ [Open Page →]  [View Raw HTML]                  │
└─────────────────────────────────────────────────┘
```

**Data transformation:**
Current `read_page` returns content with line numbers (`1→content`). Need to:
1. Strip line number prefixes for rich text display
2. Convert to HTML if content is markdown/plaintext
3. Provide toggle between rich text and raw view

### 6. ReplaceContentPreview

Specialized renderer for `replace_lines` tool results.

```typescript
// Renders when: toolName === 'replace_lines' && output.success
```

**Layout:**
```
┌─────────────────────────────────────────────────┐
│ ✓ Updated "Meeting Notes"                       │
│   Replaced lines 5-10 (6 lines → 4 lines)       │
│                                                 │
│ ┌──────────────────┬──────────────────────────┐ │
│ │ Before           │ After                    │ │
│ ├──────────────────┼──────────────────────────┤ │
│ │ Old content      │ New content              │ │
│ │ that was         │ that replaced            │ │
│ │ replaced...      │ it...                    │ │
│ └──────────────────┴──────────────────────────┘ │
│                                                 │
│ [Open Page →]                                   │
└─────────────────────────────────────────────────┘
```

**Data requirements:**
The `replace_lines` tool output needs to include before/after content:
```typescript
{
  success: boolean;
  title: string;
  linesReplaced: number;
  newLineCount: number;
  // NEEDED:
  beforeContent?: string;  // Original content that was replaced
  afterContent?: string;   // New content that replaced it
  // OR
  fullContentBefore?: string;  // Full document before
  fullContentAfter?: string;   // Full document after
}
```

---

## Tool Output Schema Updates

To support rich previews, tool outputs need additional fields:

### create_page additions:
```typescript
{
  // Existing fields...
  content?: string;        // HTML content created (for preview)
  driveSlug?: string;      // For navigation URL
}
```

### read_page additions:
```typescript
{
  // Existing fields...
  htmlContent?: string;    // Raw HTML (without line numbers)
  driveId?: string;        // For navigation URL
}
```

### replace_lines additions:
```typescript
{
  // Existing fields...
  beforeContent?: string;  // Content that was replaced
  afterContent?: string;   // New content
  contextBefore?: string;  // Lines before the change (for context)
  contextAfter?: string;   // Lines after the change (for context)
  driveId?: string;        // For navigation URL
}
```

---

## Integration with ToolCallRenderer

Update `ToolCallRenderer.tsx` to use new preview components:

```typescript
// In getOutputContent():

if (toolName === 'create_page' && result.success) {
  return (
    <CreatePagePreview
      title={result.title}
      type={result.type}
      pageId={result.id}
      driveId={result.driveId}
      content={result.content}
      parentPath={result.parentId}
    />
  );
}

if (toolName === 'read_page' && result.success && result.type === 'DOCUMENT') {
  return (
    <ReadPagePreview
      title={result.title}
      pageId={result.pageId}
      driveId={result.driveId}
      content={result.htmlContent || result.content}
      stats={result.stats}
    />
  );
}

if (toolName === 'replace_lines' && result.success) {
  return (
    <ReplaceContentPreview
      title={result.title}
      pageId={result.pageId}
      driveId={result.driveId}
      beforeContent={result.beforeContent}
      afterContent={result.afterContent}
      linesReplaced={result.linesReplaced}
      newLineCount={result.newLineCount}
    />
  );
}

// Fallback to existing DocumentRenderer for non-document types
if (toolName === 'read_page' && result.content) {
  return <DocumentRenderer ... />;  // Keep for FILE, SHEET, etc.
}
```

---

## Compact Mode Considerations

For `CompactToolCallRenderer.tsx` (sidebar):

1. **Collapsed state**: Show summary only (e.g., "Created 'Meeting Notes'")
2. **Expanded state**: Show truncated preview (max 100px height)
3. **Full view**: Link to expand in main chat area

```typescript
// Compact preview with height limit
<RichTextPreview content={content} maxHeight={100} />
```

---

## Styling Guidelines

### Preview Container
```css
.tool-preview {
  @apply rounded-md border bg-card overflow-hidden;
}

.tool-preview-header {
  @apply flex items-center gap-2 px-3 py-2 bg-muted/40 border-b;
}

.tool-preview-content {
  @apply p-3 max-h-[300px] overflow-y-auto;
}
```

### Rich Text Preview
```css
.rich-text-preview {
  @apply prose prose-sm max-w-none;
  @apply prose-headings:text-foreground;
  @apply prose-p:text-foreground;
  @apply prose-strong:text-foreground;
  @apply prose-code:text-foreground prose-code:bg-muted;
}
```

### Diff Highlighting
```css
.diff-removed {
  @apply bg-red-100 dark:bg-red-900/30 line-through;
}

.diff-added {
  @apply bg-green-100 dark:bg-green-900/30;
}
```

---

## Implementation Phases

### Phase 1: Foundation (This PR)
- [ ] Create `RichTextPreview` component
- [ ] Create `PageLink` component
- [ ] Update `read_page` tool to include `htmlContent`
- [ ] Implement `ReadPagePreview` for DOCUMENT type pages

### Phase 2: Create Page Preview
- [ ] Update `create_page` tool to include `content` in output
- [ ] Implement `CreatePagePreview` component
- [ ] Add navigation to created pages

### Phase 3: Diff Viewer
- [ ] Implement `RichTextDiff` component
- [ ] Update `replace_lines` tool to include before/after content
- [ ] Implement `ReplaceContentPreview` component

### Phase 4: Polish & Extensions
- [ ] Compact mode optimizations
- [ ] Height truncation with expand
- [ ] Additional tool previews (move_page, rename_page, etc.)
- [ ] Transition animations

---

## Testing Considerations

1. **Content rendering accuracy**: Verify TipTap output matches editor display
2. **Performance**: Test with large documents (1000+ lines)
3. **Edge cases**: Empty content, malformed HTML, special characters
4. **Navigation**: Verify page links work across drives
5. **Responsive design**: Test in narrow sidebar and full-width chat

---

## Resolved Design Questions

| Question | Decision |
|----------|----------|
| Content size limits | Fixed 816×400px container with hard truncate (no expand) |
| Lazy loading | Yes - `React.lazy()` with Suspense for RichEditor/Monaco |
| Raw view toggle | Yes - Rich/Code toggle matching document page toolbar |
| Diff granularity | Character-level for better typo/small edit visibility |
| Component reuse | Reuse existing RichEditor + MonacoEditor (no new editors) |

---

## Related Files

- `apps/web/src/components/ai/shared/chat/tool-calls/ToolCallRenderer.tsx`
- `apps/web/src/components/ai/shared/chat/tool-calls/DocumentRenderer.tsx`
- `apps/web/src/components/editors/RichEditor.tsx`
- `apps/web/src/lib/ai/tools/page-write-tools.ts`
- `apps/web/src/lib/ai/tools/page-read-tools.ts`
