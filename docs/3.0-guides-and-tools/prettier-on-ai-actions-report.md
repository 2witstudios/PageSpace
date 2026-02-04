# Prettier on AI Actions: Problem Analysis & Solution Report

## Executive Summary

**Problem:** Prettier formatting runs client-side during editing, causing:
1. Trailing spaces deleted (user data loss)
2. Content split onto new lines (visual disruption)
3. Race conditions between formatting and saving

**Root Cause:** Prettier is a full reformatter that modifies content, not just adds structure.

**Solution:** Replace Prettier with a minimal line-break inserter that runs only when AI needs it, preserving all user data.

---

## 1. The Core Problem

### Current Behavior

```
Timeline:
T=0      User types "Hello "     → local state = "Hello "
T=1000   Save fires              → DB gets "Hello " (unformatted)
T=2500   Prettier runs           → local state = "Hello" (SPACE DELETED)
         updateContentSilently() → User sees space vanish
```

### Why This Happens

Prettier (`apps/web/src/lib/editor/prettier.ts`) does full HTML reformatting:
- Removes trailing whitespace
- Wraps lines at `printWidth: 120`
- Restructures HTML elements

The trailing space restoration logic (lines 29-64) attempts to fix this but has gaps.

### Impact on Users

| Issue | User Experience |
|-------|-----------------|
| Trailing space deletion | User stops mid-thought, space vanishes, flow interrupted |
| Line wrapping | Content jumps to new line, cursor position lost |
| Visual disruption | Monaco view shows sudden reformatting |

---

## 2. Impacted AI Tools

### Read Tools (`apps/web/src/lib/ai/tools/page-read-tools.ts`)

| Tool | Impact | Current Behavior |
|------|--------|------------------|
| `read_page` | **HIGH** | Returns raw content from DB; may be unformatted, causing inconsistent line numbers |
| `list_pages` | None | Metadata only |
| `list_trash` | None | Metadata only |
| `list_conversations` | None | Chat messages, not documents |
| `read_conversation` | None | Chat messages, not documents |

### Write Tools (`apps/web/src/lib/ai/tools/page-write-tools.ts`)

| Tool | Impact | Current Behavior |
|------|--------|------------------|
| `replace_lines` | **CRITICAL** | Operates on line numbers; if content not formatted, line numbers are wrong |
| `create_page` | Low | Creates empty content |
| `rename_page` | None | Title only |
| `trash` | None | No content change |
| `restore` | None | No content change |
| `move_page` | None | No content change |
| `edit_sheet_cells` | None | Sheet format, not HTML |

### MCP Tools (`apps/web/src/app/api/mcp/documents/route.ts`)

| Operation | Impact | Current Behavior |
|-----------|--------|------------------|
| `read` | **HIGH** | Returns content with line numbers |
| `replace` | **CRITICAL** | Line-based replacement, calls `formatHtml()` after |
| `insert` | **CRITICAL** | Line-based insertion, calls `formatHtml()` after |
| `delete` | **CRITICAL** | Line-based deletion, calls `formatHtml()` after |

---

## 3. Impacted UI Surfaces

### Editor Components

| Component | File | Impact | Issue |
|-----------|------|--------|-------|
| **RichEditor** | `components/editors/RichEditor.tsx` | **HIGH** | `debouncedFormat()` at 2500ms triggers visual changes |
| **MonacoEditor** | `components/editors/MonacoEditor.tsx` | **MEDIUM** | Shows reformatted content when it arrives |

### Page Views

| View | File | Impact | Issue |
|------|------|--------|-------|
| **DocumentView** | `components/.../document/DocumentView.tsx` | **HIGH** | Receives formatted content via socket, calls `updateContentSilently()` |
| **CanvasPageView** | `components/.../canvas/CanvasPageView.tsx` | **LOW** | Custom HTML, less affected by line formatting |
| **SheetView** | `components/.../sheet/SheetView.tsx` | **NONE** | Uses cell-based format, not line-based |

### State Management

| Store/Hook | File | Impact | Issue |
|------------|------|--------|-------|
| **useDocument** | `hooks/useDocument.ts` | **HIGH** | `updateContentSilently()` applies formatted content |
| **useDocumentStore** | `stores/useDocumentStore.ts` | **MEDIUM** | Stores content state |
| **useEditingStore** | `stores/useEditingStore.ts` | **LOW** | Protects during editing, but doesn't prevent formatting |

### API Routes

| Route | File | Impact | Issue |
|-------|------|--------|-------|
| **PATCH /api/pages/:id** | `app/api/pages/[pageId]/route.ts` | **MEDIUM** | Saves content as-is (no server-side formatting currently) |
| **MCP /api/mcp/documents** | `app/api/mcp/documents/route.ts` | **HIGH** | Has its own `formatHtml()` duplicate |

---

## 4. Data Flow Analysis

### Current Flow (Problematic)

```
┌─────────────────────────────────────────────────────────────────────┐
│ USER EDITING                                                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User types "Hello "                                                │
│       │                                                             │
│       ▼                                                             │
│  RichEditor.onChange()                                              │
│       │                                                             │
│       ├──────────────────────┐                                      │
│       ▼                      ▼                                      │
│  updateContent()        debouncedFormat()                           │
│  (isDirty=true)         (2500ms timer)                              │
│       │                      │                                      │
│       ▼                      ▼                                      │
│  saveWithDebounce()     formatHtml()                                │
│  (1000ms timer)              │                                      │
│       │                      ▼                                      │
│       ▼                 updateContentSilently()                     │
│  PATCH /api/pages/:id        │                                      │
│       │                      ▼                                      │
│       ▼                 LOCAL STATE = "Hello" ← SPACE DELETED       │
│  DB = "Hello "                                                      │
│  (unformatted)                                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ AI EDITING                                                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  AI calls read_page                                                 │
│       │                                                             │
│       ▼                                                             │
│  Fetch from DB → "Hello " (unformatted, single line)                │
│       │                                                             │
│       ▼                                                             │
│  Return to AI with line numbers                                     │
│  (But if single line, all content is "line 1")                      │
│       │                                                             │
│       ▼                                                             │
│  AI calls replace_lines(startLine=1, ...)                           │
│       │                                                             │
│       ▼                                                             │
│  Line numbers may not match expected structure                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Proposed Flow (Solution)

```
┌─────────────────────────────────────────────────────────────────────┐
│ USER EDITING                                                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User types "Hello "                                                │
│       │                                                             │
│       ▼                                                             │
│  RichEditor.onChange()                                              │
│       │                                                             │
│       ▼                                                             │
│  updateContent()                                                    │
│  (isDirty=true)                                                     │
│       │                                                             │
│       ▼                                                             │
│  saveWithDebounce()                                                 │
│  (1000ms timer)                                                     │
│       │                                                             │
│       ▼                                                             │
│  PATCH /api/pages/:id                                               │
│       │                                                             │
│       ▼                                                             │
│  DB = "Hello "  ←── NO FORMATTING, USER DATA PRESERVED              │
│                                                                     │
│  LOCAL STATE = "Hello " ←── UNCHANGED, NO VISUAL DISRUPTION         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ AI EDITING                                                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  AI calls read_page                                                 │
│       │                                                             │
│       ▼                                                             │
│  Fetch from DB → "Hello "                                           │
│       │                                                             │
│       ▼                                                             │
│  addLineBreaksForAI() ←── ONLY ADDS NEWLINES, PRESERVES SPACES      │
│       │                                                             │
│       ▼                                                             │
│  Return to AI: "<p>\nHello \n</p>" with line numbers                │
│       │                                                             │
│       ▼                                                             │
│  AI calls replace_lines(startLine=2, content="Hello World ")        │
│       │                                                             │
│       ▼                                                             │
│  Fetch latest from DB                                               │
│       │                                                             │
│       ▼                                                             │
│  addLineBreaksForAI() → Apply line replacement → Save               │
│       │                                                             │
│       ▼                                                             │
│  DB = "<p>\nHello World \n</p>" ←── TRAILING SPACE PRESERVED        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Proposed Solution

### Core Change: Replace Prettier with Minimal Line-Break Inserter

**New utility:** `addLineBreaksForAI(html: string): string`

```typescript
/**
 * Adds line breaks between HTML tags for AI line-based editing.
 *
 * IMPORTANT: This function ONLY adds newlines. It does NOT:
 * - Remove trailing spaces
 * - Reformat content
 * - Change any existing characters
 *
 * This preserves user data while giving AI predictable line numbers.
 */
export function addLineBreaksForAI(html: string): string {
  if (!html || typeof html !== 'string') return html;

  // Add newline after opening tags (except self-closing and inline)
  // Add newline before closing tags
  // Preserve all existing content including whitespace

  const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                     'ul', 'ol', 'li', 'table', 'tr', 'td', 'th',
                     'blockquote', 'pre', 'section', 'article', 'header',
                     'footer', 'nav', 'aside', 'main'];

  let result = html;

  for (const tag of blockTags) {
    // Add newline after opening tag (if not already present)
    result = result.replace(
      new RegExp(`(<${tag}[^>]*>)(?!\n)`, 'gi'),
      '$1\n'
    );
    // Add newline before closing tag (if not already present)
    result = result.replace(
      new RegExp(`(?<!\n)(</${tag}>)`, 'gi'),
      '\n$1'
    );
  }

  // Collapse multiple consecutive newlines to single newline
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}
```

### Where to Apply

| Location | Change |
|----------|--------|
| `page-read-tools.ts` → `read_page` | Call `addLineBreaksForAI()` before returning content |
| `page-write-tools.ts` → `replace_lines` | Call `addLineBreaksForAI()` before applying line replacement |
| `mcp/documents/route.ts` | Replace `formatHtml()` with `addLineBreaksForAI()` |
| `RichEditor.tsx` | **REMOVE** `debouncedFormat()` and `onFormatChange` logic |
| `DocumentView.tsx` | **REMOVE** `handleFormatChange` callback |

---

## 6. Implementation Plan

### Phase 1: Create New Utility

**File:** `apps/web/src/lib/editor/line-breaks.ts`

- Implement `addLineBreaksForAI()`
- Add comprehensive tests
- Ensure it preserves all whitespace including trailing spaces

### Phase 2: Update AI Tools

**Files:**
- `apps/web/src/lib/ai/tools/page-read-tools.ts`
- `apps/web/src/lib/ai/tools/page-write-tools.ts`

**Changes:**
- Import `addLineBreaksForAI`
- Apply to content in `read_page` before returning
- Apply to content in `replace_lines` before line operations

### Phase 3: Update MCP Route

**File:** `apps/web/src/app/api/mcp/documents/route.ts`

**Changes:**
- Replace `formatHtml()` calls with `addLineBreaksForAI()`
- Remove duplicate `formatHtml` function

### Phase 4: Remove Client-Side Formatting

**Files:**
- `apps/web/src/components/editors/RichEditor.tsx`
- `apps/web/src/components/layout/middle-content/page-views/document/DocumentView.tsx`

**Changes:**
- Remove `debouncedFormat()` function and timer
- Remove `onFormatChange` prop and handler
- Remove `formatVersion` tracking
- Keep `onChange` for normal content updates

### Phase 5: Cleanup

**Files:**
- `apps/web/src/lib/editor/prettier.ts` - Consider deprecating or keeping for other uses
- `apps/web/src/hooks/useDocument.ts` - Remove `updateContentSilently` if no longer needed

---

## 7. Testing Strategy

### Unit Tests

```typescript
describe('addLineBreaksForAI', () => {
  it('preserves trailing spaces', () => {
    const input = '<p>Hello </p>';
    const output = addLineBreaksForAI(input);
    expect(output).toContain('Hello ');  // Space preserved
  });

  it('adds line breaks between block tags', () => {
    const input = '<p>First</p><p>Second</p>';
    const output = addLineBreaksForAI(input);
    expect(output.split('\n').length).toBeGreaterThan(1);
  });

  it('does not modify inline content', () => {
    const input = '<p>Hello <strong>world</strong></p>';
    const output = addLineBreaksForAI(input);
    expect(output).toContain('Hello <strong>world</strong>');
  });
});
```

### Integration Tests

1. **AI Read/Write Cycle:**
   - Create document with trailing spaces
   - AI reads via `read_page`
   - AI edits via `replace_lines`
   - Verify trailing spaces preserved

2. **User Editing Experience:**
   - Type content with trailing spaces
   - Wait for save
   - Verify no visual changes
   - Verify trailing spaces in saved content

3. **Concurrent Editing:**
   - User editing document
   - AI makes changes
   - Verify no data loss

---

## 8. Rollback Plan

If issues arise:

1. Revert AI tool changes (re-enable Prettier in tools)
2. Revert RichEditor changes (restore `debouncedFormat`)
3. Keep `addLineBreaksForAI` for future use

The changes are modular and can be reverted independently.

---

## 9. Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Trailing spaces preserved | No | Yes |
| Visual disruption during editing | Yes (at T=2500ms) | None |
| AI line-based editing works | Sometimes | Always |
| User data integrity | Compromised | Preserved |

---

## 10. Open Questions

1. **Should we keep Prettier for any use case?** (e.g., explicit "Format Document" command)
2. **How do we handle existing formatted content in DB?** (Answer: It stays formatted, new content stays raw)
3. **Should we add a user preference for auto-formatting?** (Future consideration)

---

## Appendix: File Change Summary

| File | Action | Lines Changed (est.) |
|------|--------|---------------------|
| `lib/editor/line-breaks.ts` | **CREATE** | +50 |
| `lib/ai/tools/page-read-tools.ts` | MODIFY | +5 |
| `lib/ai/tools/page-write-tools.ts` | MODIFY | +10 |
| `app/api/mcp/documents/route.ts` | MODIFY | -30, +5 |
| `components/editors/RichEditor.tsx` | MODIFY | -40 |
| `components/.../DocumentView.tsx` | MODIFY | -10 |
| `lib/editor/prettier.ts` | DEPRECATE | (keep for now) |

**Total estimated changes:** ~150 lines (mostly deletions)

---

*Report generated: 2026-02-04*
*Branch: claude/prettier-on-ai-actions-Mcxb2*
