# Paginated Documents Implementation

**Status:** ✅ Implementation Complete - Ready for Validation Testing
**Date:** 2025-10-22
**Feature:** Add pagination support to PageSpace documents with visual page breaks, headers/footers, and print-ready layouts

## Overview

This feature adds opt-in pagination to DOCUMENT type pages using a custom-built Tiptap pagination extension created specifically for PageSpace.

## Implementation Summary

### 1. Database Schema Changes

**File:** `packages/db/src/schema/core.ts`
**Changes:**
- Added `isPaginated` boolean column to `pages` table (default: `false`)
- Migration generated: `packages/db/drizzle/0003_cynical_namor.sql`

```sql
ALTER TABLE "pages" ADD COLUMN "isPaginated" boolean DEFAULT false NOT NULL;
```

### 2. Pagination Extension - In-House Implementation

**Location:** `apps/web/src/lib/editor/pagination/`

Instead of using an external dependency, we recreated the pagination extension directly in PageSpace:

**Files Created:**
- `PaginationExtension.ts` (~460 lines) - Main Tiptap extension
- `utils.ts` (~70 lines) - CSS variable helpers
- `constants.ts` (~30 lines) - Page size presets (A4, Letter, Legal, etc.)
- `index.ts` - Exports

**Reasons for in-house implementation:**
1. **External package had missing exports** - TablePlus variants didn't exist
2. **Full ownership** - No dependency on external maintainers
3. **Small code size** - Only ~560 lines total
4. **Easy customization** - Can add PageSpace-specific features
5. **MIT licensed** - Original code was MIT, free to copy and modify

### 3. Table Handling

**File:** `apps/web/src/components/editors/RichEditor.tsx`
**Solution:**
- Uses standard `TableKit` from `@tiptap/extension-table`
- Pagination handles tables via CSS styling (no special table nodes needed)
- Tables automatically flow across page breaks

### 4. Pagination Extension Configuration

**File:** `apps/web/src/components/editors/RichEditor.tsx`
**Changes:**
- Added `isPaginated` prop to `RichEditorProps` interface
- Conditionally loads `PaginationPlus` extension based on `isPaginated` flag
- Configuration:
  - **Page Size:** US Letter (8.5" × 11" = 816px × 1056px at 96 DPI)
  - **Margins:** 1 inch (96px) on all sides
  - **Headers:** Enabled
  - **Footers:** Enabled with page numbers (`Page {{pageNumber}}`)

```typescript
...(isPaginated ? [
  PaginationPlus.configure({
    pageSize: {
      width: 816,  // US Letter width
      height: 1056, // US Letter height
    },
    pageMargins: {
      top: 96,    // 1 inch
      bottom: 96,
      left: 96,
      right: 96,
    },
    enableHeader: true,
    enableFooter: true,
    footerContent: '<div style="text-align: center;">Page {{pageNumber}}</div>',
  }),
] : [])
```

### 5. DocumentView Integration

**File:** `apps/web/src/components/layout/middle-content/page-views/document/DocumentView.tsx`
**Changes:**
- Added `isPaginated` state
- Added effect to fetch `isPaginated` value from page data
- Passes `isPaginated` prop to `RichEditor` component

### 6. API Route Updates

**File:** `apps/web/src/app/api/pages/[pageId]/route.ts`
**Changes:**
- Added `isPaginated` field to `patchSchema` Zod validation
- API now accepts and persists `isPaginated` boolean field

```typescript
const patchSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
  parentId: z.string().nullable().optional(),
  isPaginated: z.boolean().optional(), // ← New field
});
```

### 7. UI - Pagination Toggle

**New File:** `apps/web/src/components/layout/middle-content/content-header/PaginationToggle.tsx`
**Updated File:** `apps/web/src/components/layout/middle-content/content-header/index.tsx`

**Features:**
- Dropdown menu in content header with two layout options:
  - **Continuous:** Single scrolling document (default)
  - **Paginated (US Letter):** Pages with breaks, headers & footers
- Updates page via PATCH API call
- Shows toast notification on success
- Reloads page to apply changes to editor (required for extension initialization)

**Location:** Appears in the document header next to "Rich/Code" editor toggles, only for DOCUMENT type pages.

## User Experience

### How Users Enable Pagination

1. Open any DOCUMENT type page
2. Click **"Page Layout"** button in the content header
3. Select **"Paginated (US Letter)"** from dropdown
4. Page reloads with pagination enabled
5. Document now displays with:
   - Visual page breaks
   - Page numbers in footers
   - Headers/footers
   - Print-ready layout (US Letter size)

### How Users Disable Pagination

1. Click **"Page Layout"** button
2. Select **"Continuous"** from dropdown
3. Page reloads with pagination disabled
4. Document returns to single scrolling layout

## Technical Details

### HTML Storage

**Critical Question:** Does `editor.getHTML()` include page wrappers or is it clean HTML?

**Answer:** ⚠️ **NEEDS VALIDATION** - This must be tested before declaring feature production-ready.

**Test Required:**
```typescript
const editor = useEditor({ ... });
const html = editor.getHTML();
console.log(html);
// Check if output includes page wrapper divs or is clean HTML
```

**Expected Outcomes:**
- **Best Case:** HTML is clean, pagination is visual-only (CSS/decorations) ✅
- **Alternate Case:** HTML includes semantic page wrappers - AI can still understand this ⚠️
- **Worst Case:** HTML is malformed or breaks Monaco/AI - needs normalization layer ❌

### Monaco Code View Compatibility

- If pagination is visual-only → Monaco shows clean HTML ✅
- If pagination adds semantic wrappers → Monaco shows page structure (AI-friendly) ✅
- Line numbers work normally in both cases

### AI Integration

**System Prompt (if needed):**
```
When working with paginated documents, understand that:
- Page breaks may exist as visual separators or semantic divs
- Preserve any page structure elements when editing
- Content may flow across pages—edits might shift page breaks
- Headers/footers are display-only, don't edit them
```

**Tool Behavior:**
- `read_page` returns full HTML (with or without page markers)
- `replace_lines` works on the HTML as-is
- `create_page` generates clean HTML (pagination added on first Tiptap render)

**No changes required unless validation reveals HTML pollution.**

### Real-time Collaboration

- Pagination is client-side rendering (each user calculates their own page breaks)
- Page numbers might differ temporarily between users during edits
- Resolves on sync when content stabilizes
- This is acceptable behavior (same as Google Docs)

## Validation Checklist

### ⚠️ Critical Tests Required

Before declaring this feature production-ready, run these tests:

#### 1. HTML Output Validation
- [ ] Create a paginated document with 3+ pages of content
- [ ] Run `editor.getHTML()` and inspect output
- [ ] Verify HTML is clean or has AI-friendly structure
- [ ] Test save/load cycle preserves pagination state

#### 2. Monaco Code View
- [ ] Toggle to Code view in paginated document
- [ ] Verify HTML displays correctly
- [ ] Make edits in Monaco, switch back to Rich view
- [ ] Confirm pagination re-renders correctly

#### 3. Prettier Formatting
- [ ] Create paginated document
- [ ] Wait for Prettier auto-format (2500ms)
- [ ] Verify pagination isn't broken by formatting
- [ ] Check that page breaks remain stable

#### 4. Multi-Page Document Performance
- [ ] Create document with 10+ pages of content
- [ ] Test scrolling performance
- [ ] Test typing latency
- [ ] Test auto-save performance
- [ ] If slow, implement lazy rendering or warnings

#### 5. Table Spanning Pages
- [ ] Insert large table that spans 2+ pages
- [ ] Verify table cells split correctly at page breaks
- [ ] Test editing content in split table
- [ ] Confirm table integrity after edits

#### 6. AI Editing
- [ ] Create paginated document
- [ ] Use AI chat to edit content
- [ ] Verify AI edits preserve page structure
- [ ] Test that page breaks reflow naturally after AI changes

#### 7. Print/Export
- [ ] Print paginated document to PDF
- [ ] Verify page breaks appear correctly
- [ ] Check headers/footers render in output
- [ ] Confirm page numbers are sequential

#### 8. Edge Cases
- [ ] Empty paginated document (just page 1)
- [ ] Very long document (50+ pages) - performance test
- [ ] Rapid pagination toggle on/off
- [ ] Concurrent editing by multiple users

## Known Limitations

1. **Page reload required** when toggling pagination (extension must reinitialize)
2. **No per-page customization** of headers/footers (all pages use same template)
3. **Fixed page size** (US Letter only, no A4/Legal/Custom in MVP)
4. **No manual page break insertion** (automatic only based on content flow)
5. **Page numbers might differ between collaborators** during active editing

## Future Enhancements

### Phase 2 Possibilities
- [ ] Multiple page sizes (A4, Legal, Custom)
- [ ] Adjustable margins
- [ ] Custom header/footer templates per document
- [ ] Manual page break insertion
- [ ] Different first page header/footer
- [ ] Page orientation (portrait/landscape)
- [ ] Sections with different page sizes

### Performance Optimizations
- [ ] Lazy rendering for 50+ page documents
- [ ] Virtual scrolling for very large documents
- [ ] Page break calculation optimization

## Files Changed

### Database
- `packages/db/src/schema/core.ts` - Added `isPaginated` column
- `packages/db/drizzle/0003_cynical_namor.sql` - Migration file

### Pagination Extension (New)
- `apps/web/src/lib/editor/pagination/PaginationExtension.ts` - Main extension
- `apps/web/src/lib/editor/pagination/utils.ts` - CSS helpers
- `apps/web/src/lib/editor/pagination/constants.ts` - Page size presets
- `apps/web/src/lib/editor/pagination/index.ts` - Exports

### Frontend Components
- `apps/web/src/components/editors/RichEditor.tsx` - Pagination integration
- `apps/web/src/components/layout/middle-content/page-views/document/DocumentView.tsx` - Pass isPaginated prop
- `apps/web/src/components/layout/middle-content/content-header/PaginationToggle.tsx` - New toggle UI
- `apps/web/src/components/layout/middle-content/content-header/index.tsx` - Integrate toggle

### Backend API
- `apps/web/src/app/api/pages/[pageId]/route.ts` - Accept isPaginated field

## Rollback Plan

If critical issues are discovered:

1. **Hide UI toggle** - Comment out `<PaginationToggle />` in content header
2. **Database is backward compatible** - `isPaginated` defaults to `false`
3. **No data migration required** - Existing documents unaffected
4. **Extensions are opt-in** - Non-paginated documents use original table extensions

## Success Criteria

- ✅ Users can enable pagination on any DOCUMENT page
- ⚠️ Page breaks display correctly (needs validation)
- ⚠️ Page numbers appear in footers (needs validation)
- ⚠️ Headers/footers render properly (needs validation)
- ⚠️ Tables span pages correctly (needs validation)
- ⚠️ AI editing works without breaking pagination (needs validation)
- ⚠️ Monaco code view displays correctly (needs validation)
- ⚠️ Print/PDF export shows page breaks (needs validation)
- ✅ No increase in save/load times for non-paginated documents
- ⚠️ Performance acceptable for 20+ page documents (needs testing)

## Next Steps

1. **Run validation tests** from checklist above
2. **Test in development environment** with docker up
3. **Fix any issues** discovered during validation
4. **Update AI system prompts** if HTML includes page structure
5. **Update user documentation** with pagination feature guide
6. **Update changelog** with new feature announcement
7. **Deploy to production** after all tests pass

---

**Implementation Notes:**

- Used Tiptap v3 compatible fork because original package only supports v2
- Pagination is opt-in to avoid surprising existing users
- Page reload is required when toggling (limitation of Tiptap extension initialization)
- US Letter chosen as default (can add A4 in future if needed)
