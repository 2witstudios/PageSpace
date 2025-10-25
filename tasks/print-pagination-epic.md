# Print Pagination Epic

**Status**: 🔄 IN PROGRESS (Phase 4)
**Goal**: WYSIWYG print output matching paginated editor view exactly

## Overview

Users switch to pagination view specifically to create print-ready documents, but the print output currently doesn't respect the visual page boundaries shown in the editor. This breaks the fundamental promise of the feature and blocks adoption for anyone who needs to print. We're building a sophisticated pagination engine with a dedicated print route, Web Worker computation, and pre-paginated rendering to ensure 1:1 fidelity between editor and print output.

---

## Phase 1: Refactor Existing Print Handler ✅ COMPLETED (2025-10-24)

Migrate current inline DOM injection approach to reusable pagination calculation module.

**Delivered**:
- ✅ Created `page-breaker.ts` with pure `calculatePageBreaks()` function
- ✅ Returns structured break metadata: `PageBreakMetadata[]` with `pageIndex`, `elementIndex`, `previousPageHeight`, `triggerElementHeight`
- ✅ Refactored `print-handler.ts` to use new calculation module (maintains existing behavior)
- ✅ Created comprehensive test suite with 22 unit tests (all passing)
- ✅ Tests cover: basic pagination, multiple pages, edge cases (zero height, overflow tolerance), headings, metadata validation
- ✅ Zero TypeScript errors, follows project conventions

---

## Phase 2: Build Dedicated Print Route ✅ COMPLETED (2025-10-24)

Create `/print/[pageId]` Next.js 15 route that renders pre-paginated content.

**Delivered**:
- ✅ Created `/app/print/[pageId]/page.tsx` with Next.js 15 async params pattern
- ✅ Implemented JWT authentication with permission checks (canUserViewPage)
- ✅ Fetches page content from database with proper error handling
- ✅ Created `PrintView.tsx` client component with loading state
- ✅ Calculates page breaks using `calculatePageBreaks()` from Phase 1
- ✅ Renders fixed-height page containers (816px x 1056px for Letter size)
- ✅ Auto-triggers `window.print()` via MutationObserver + requestIdleCallback
- ✅ Includes print-specific CSS with `@page` rules to remove browser headers/footers
- ✅ Shows error state with user-friendly messages
- ✅ Waits for `document.fonts.ready` before triggering print

---

## Phase 3: Implement Read-Only Tiptap Renderer ✅ COMPLETED (2025-10-24)

Create component that renders Tiptap content without editing capabilities for print surface.

**Requirements**:
- Given ProseMirror JSON content, when rendering, then component should display formatted content using Tiptap extensions
- Given the renderer is for print, when initializing, then component should disable all editing features (editable: false)
- Given page break metadata, when rendering, then component should split content into separate page fragments
- Given rendered content, when measuring, then heights should match editor exactly (same fonts, spacing, styles)

**Delivered**:
- ✅ Created `ReadOnlyEditor.tsx` component with Tiptap + identical extension set to main editor
- ✅ Configured with `editable: false`, no placeholders, no editing UI (BubbleMenu/FloatingMenu)
- ✅ Extensions match RichEditor: StarterKit, Markdown, TextStyleKit, TableKit, CharacterCount, PageMention
- ✅ Integrated into `PrintView.tsx` - replaces innerHTML approach with proper Tiptap rendering
- ✅ Implemented two-phase rendering: hidden editor for measurements → split content across print pages
- ✅ Content splitting algorithm: calculates break points from rendered DOM, splits elements into page arrays
- ✅ Print CSS: hides measurement editor, applies proper page breaks, ensures typography matches
- ✅ Font loading: waits for `document.fonts.ready` before measuring heights
- ✅ Build successful: `/print/[pageId]` route at 119 kB (includes full Tiptap + extensions)
- ✅ Zero TypeScript errors, follows Next.js 15 patterns

---

## Phase 4: Create Pagination Engine Module

Build core pagination algorithm that walks ProseMirror DOM and computes exact break points.

**Requirements**:
- Given ProseMirror content DOM, when walking nodes, then engine should use `DOMRange.getClientRects()` for measurement
- Given cumulative height tracking, when element exceeds page boundary, then engine should record break point before that element
- Given break points computed, when splitting text nodes, then engine should use `Range.splitText()` to preserve formatting
- Given complex block nodes (lists, tables), when encountering, then engine should break at semantic boundaries (list items, table rows)
- Given atomic nodes (images, code blocks), when measuring, then engine should treat as indivisible units

---

## Phase 5: Add Web Worker Support

Wrap pagination engine in Web Worker to maintain UI responsiveness for large documents.

**Requirements**:
- Given pagination engine module, when creating worker, then worker should accept ProseMirror JSON + config as input
- Given worker receives message, when computing, then worker should execute pagination algorithm and return break metadata
- Given worker computation completes, when posting result, then main thread should receive serializable break metadata array
- Given 50+ page document, when computing pagination, then UI should remain responsive with no jank or freezing

---

## Phase 6: Implement IndexedDB Caching

Cache computed pagination results by content hash for instant repeated prints.

**Requirements**:
- Given document content, when computing hash, then system should use stable content-based hash (SHA-256 of JSON)
- Given break metadata computed, when storing, then system should cache in IndexedDB with content hash as key
- Given cached results exist for content hash, when printing, then system should retrieve from cache instantly
- Given content changes, when computing hash, then cache should miss and trigger recomputation

---

## Phase 7: Update Print Button Handler

Modify existing print trigger to use new print route instead of inline DOM modification.

**Requirements**:
- Given user clicks Print button, when handling, then system should open `/print/[pageId]` in new tab
- Given print route opens, when waiting for ready, then system should display loading indicator in both editor and print tab
- Given error during print preparation, when handling, then system should show user-friendly error message with fallback option
- Given legacy print handler exists, when new route fails, then system should fall back to existing inline approach

---

## Phase 8: Typography & Font Preloading

Ensure all fonts are loaded before pagination computation for accurate measurements.

**Requirements**:
- Given custom fonts in use, when preparing print, then system should preload all font-faces before rendering
- Given fonts loading, when monitoring, then system should use `document.fonts.ready` promise
- Given fonts loaded, when computing pagination, then measurements should be stable and accurate
- Given print CSS applied, when rendering, then system should use `print-color-adjust: exact` to preserve colors

---

## Phase 9: Complex Node Support (Lists)

Extend pagination engine to handle nested lists with proper semantic preservation.

**Requirements**:
- Given ordered/unordered lists, when splitting, then engine should maintain list numbering continuity across pages
- Given nested lists, when encountering page break, then engine should preserve indentation and hierarchy
- Given list item spans pages, when splitting, then engine should prefer breaking between items over mid-item breaks
- Given list starts near page end, when measuring, then engine should keep list header with first item (widow/orphan control)

---

## Phase 10: Complex Node Support (Tables)

Extend pagination engine to handle tables with row-aware splitting.

**Requirements**:
- Given table spans pages, when splitting, then engine should break between rows, never mid-row
- Given table headers, when breaking, then engine should optionally repeat headers on new pages
- Given table row too tall for page, when measuring, then engine should move entire row to next page
- Given nested tables, when encountering page break, then engine should handle recursively with same rules

---

## Phase 11: Media & Embed Support

Extend pagination engine to handle images, videos, and embedded content as atomic units.

**Requirements**:
- Given image node, when measuring, then engine should treat as indivisible (never split)
- Given image doesn't fit on current page, when deciding, then engine should move entire image to next page
- Given image taller than page height, when handling overflow, then engine should allow it to span page naturally
- Given embedded iframe/video, when measuring, then engine should treat as atomic unit like images

---

## Phase 12: Visual Regression Test Suite

Build automated testing infrastructure to detect pagination drift.

**Requirements**:
- Given editor view rendered, when capturing, then system should screenshot each visible page boundary
- Given print output rendered, when capturing, then system should screenshot each printed page
- Given editor and print screenshots, when comparing, then system should diff images with ±5px tolerance
- Given visual regression detected, when failing test, then system should output annotated diff image showing misalignment

---

## Phase 13: Unit Test Coverage

Comprehensive unit tests for pagination engine logic per node type.

**Requirements**:
- Given pagination engine, when testing paragraphs, then tests should verify correct break point calculation
- Given pagination engine, when testing headings, then tests should verify widow/orphan prevention
- Given pagination engine, when testing lists, then tests should verify semantic preservation
- Given pagination engine, when testing tables, then tests should verify row-level breaking
- Given pagination engine, when testing edge cases, then tests should cover empty nodes, very long words, mixed content

---

## Phase 14: Integration Test Suite

End-to-end tests for complete print flow from button click to dialog.

**Requirements**:
- Given user clicks Print button, when testing flow, then test should verify new tab opens with correct URL
- Given print route loads, when testing, then test should verify loading state appears during computation
- Given pagination completes, when testing, then test should verify browser print dialog triggers
- Given print dialog cancels, when testing, then test should verify clean state restoration

---

## Phase 15: Performance Benchmarking

Establish performance baselines and optimization targets.

**Requirements**:
- Given 10-page document, when benchmarking, then pagination should complete in <500ms
- Given 50-page document, when benchmarking, then pagination should complete in <2s
- Given 100-page document, when benchmarking, then pagination should complete in <5s
- Given repeated prints, when benchmarking, then cache hit should return results in <50ms

---

## Phase 16: Error Handling & Fallbacks

Robust error handling with graceful degradation.

**Requirements**:
- Given Web Worker fails to load, when handling error, then system should fall back to main thread computation
- Given IndexedDB unavailable, when handling error, then system should compute without caching
- Given pagination computation times out, when handling, then system should show error with retry option
- Given print route fails to load, when handling, then system should fall back to legacy inline print approach

---

## Phase 17: Production Hardening

Final polish for production deployment confidence.

**Requirements**:
- Given pagination feature complete, when reviewing, then all TypeScript types should be explicit (no `any`)
- Given production deployment, when monitoring, then errors should be logged with proper context
- Given edge cases discovered, when fixing, then fixes should include regression tests
- Given accessibility audit, when reviewing, then printed output should be selectable, searchable, and screen-reader compatible

---

## Phase 18: Documentation & Migration Guide

User-facing and developer documentation for the feature.

**Requirements**:
- Given pagination feature shipped, when documenting, then architecture doc should be updated with actual implementation details
- Given developers onboarding, when reading docs, then should understand print route flow and worker architecture
- Given users encountering issues, when troubleshooting, then docs should cover common problems and solutions
- Given feature evolution, when maintaining, then changelog should track all breaking changes and migrations
