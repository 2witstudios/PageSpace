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

## Component Architecture

```
apps/web/src/components/ai/shared/chat/tool-calls/
├── ToolCallRenderer.tsx          # Main orchestrator (existing)
├── CompactToolCallRenderer.tsx   # Sidebar version (existing)
├── DocumentRenderer.tsx          # Code/text display (existing)
├── FileTreeRenderer.tsx          # Page hierarchy (existing)
├── TaskRenderer.tsx              # Task management (existing)
│
├── previews/                     # NEW: Rich text preview components
│   ├── RichTextPreview.tsx       # Lightweight read-only TipTap renderer
│   ├── RichTextDiff.tsx          # Side-by-side or inline diff viewer
│   ├── CreatePagePreview.tsx     # create_page tool renderer
│   ├── ReadPagePreview.tsx       # read_page tool renderer
│   ├── ReplaceContentPreview.tsx # replace_lines tool renderer
│   └── PageLink.tsx              # Clickable page navigation component
```

---

## Component Specifications

### 1. RichTextPreview

A lightweight, read-only TipTap editor for rendering HTML content in tool previews.

```typescript
interface RichTextPreviewProps {
  content: string;           // HTML content
  maxHeight?: number;        // Optional height limit with fade/expand
  className?: string;
}
```

**Key differences from RichEditor:**
- No editing capabilities (menus, placeholders, formatting)
- Minimal TipTap extensions (StarterKit only)
- Optimized for inline display (no character count, no callbacks)
- Optional height truncation with "Show more" expansion
- Preserves TipTap's prose styling for consistency

**Implementation approach:**
```tsx
const RichTextPreview: React.FC<RichTextPreviewProps> = ({ content, maxHeight = 200 }) => {
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content,
    editable: false,
    immediatelyRender: false,
  });

  return (
    <div className={cn("prose prose-sm max-w-none", maxHeight && "max-h-[200px] overflow-hidden")}>
      <EditorContent editor={editor} />
      {/* Optional: Fade gradient and "Show more" button if truncated */}
    </div>
  );
};
```

### 2. RichTextDiff

Visual diff viewer for rich text content changes.

```typescript
interface RichTextDiffProps {
  before: string;            // Original HTML content
  after: string;             // Modified HTML content
  mode?: 'side-by-side' | 'inline' | 'unified';
  highlightChanges?: boolean;
}
```

**Display modes:**

| Mode | Description | Use Case |
|------|-------------|----------|
| `side-by-side` | Two columns: before (red) / after (green) | Larger changes |
| `inline` | Single view with strikethrough/highlight | Small edits |
| `unified` | Git-style unified diff | Technical users |

**Implementation approach:**
1. Parse HTML to text for diff computation
2. Use `diff` library (or similar) to compute changes
3. Render both versions with change highlighting
4. For inline mode: use `<del>` and `<ins>` tags

```tsx
const RichTextDiff: React.FC<RichTextDiffProps> = ({ before, after, mode = 'side-by-side' }) => {
  if (mode === 'side-by-side') {
    return (
      <div className="grid grid-cols-2 gap-4">
        <div className="border-l-2 border-red-500 pl-2">
          <div className="text-xs text-muted-foreground mb-1">Before</div>
          <RichTextPreview content={before} />
        </div>
        <div className="border-l-2 border-green-500 pl-2">
          <div className="text-xs text-muted-foreground mb-1">After</div>
          <RichTextPreview content={after} />
        </div>
      </div>
    );
  }
  // ... other modes
};
```

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

## Open Questions

1. **Content size limits**: Should we limit preview content to first N characters/lines?
2. **Lazy loading**: Should TipTap editor be lazily loaded for performance?
3. **Raw view toggle**: Should users be able to switch to raw HTML/code view?
4. **Diff granularity**: Line-level diff vs. character-level diff for replace operations?

---

## Related Files

- `apps/web/src/components/ai/shared/chat/tool-calls/ToolCallRenderer.tsx`
- `apps/web/src/components/ai/shared/chat/tool-calls/DocumentRenderer.tsx`
- `apps/web/src/components/editors/RichEditor.tsx`
- `apps/web/src/lib/ai/tools/page-write-tools.ts`
- `apps/web/src/lib/ai/tools/page-read-tools.ts`
