# Print Pagination Feature PRD

**Status**: Approved for Implementation
**Priority**: P0 - Feature Blocker
**Owner**: Engineering
**Created**: 2025-10-24

---

## Executive Summary

PageSpace's pagination view currently displays visual page boundaries, but print output doesn't respect them. This breaks the fundamental promise of the feature. We're building a sophisticated print pagination engine that computes exact page breaks from document HTML and renders a pre-paginated print surface, ensuring 1:1 fidelity between editor and print output.

**Goal**: WYSIWYG printing - what users see in pagination view = what they get when printing.

---

## Problem Description

### Why are we building this?

PageSpace currently offers a **pageless view** for continuous, web-native editing. However, users creating documents for print distribution (resumes, reports, proposals, academic papers, business letters) need to see exactly where page boundaries will occur.

We introduced a **pagination view** with visual decorations showing page boundaries, but there's a critical gap: **the print output doesn't respect these boundaries**. This breaks the fundamental promise of the feature.

### The Pain Point

Users switch to pagination view specifically because they need print-ready documents. When they click Print, the browser sees continuous HTML without pagination metadata, resulting in arbitrary page breaks that don't match the editor. This makes pagination view worthless for its intended purpose.

### Impact

- Users lose trust in pagination view
- Print-ready documents require manual adjustment or external tools
- Feature is effectively broken until print works
- Blocks adoption for entire user segment (anyone who needs to print)

### Priority

**P0 - This is table stakes for the feature.** Pagination view without working print is like a WYSIWYG editor that isn't WYSIWYG.

---

## Solution Description

### What are we building?

A sophisticated **print pagination engine** that computes exact page breaks from document HTML and renders a pre-paginated print surface, ensuring 1:1 fidelity between editor and print output.

### Core Components

#### 1. Pagination Engine (`page-breaker.ts`)
- Walks ProseMirror DOM using `DOMRange` + `getClientRects()`
- Measures rendered content height against page boundaries
- Splits nodes at exact break points using DOM Range APIs
- Generates break metadata: `{ pageIndex, nodeId, offset }[]`
- Handles all node types: paragraphs, headings, lists, tables, images, code blocks, embeds

#### 2. Web Worker (`page-breaker.worker.ts`)
- Offloads pagination computation for responsiveness
- Accepts: ProseMirror JSON + pagination config
- Returns: Break metadata + page content fragments
- Caches results by content hash in IndexedDB for instant re-prints

#### 3. Print Route (`/print/[pageId]`)
- Dedicated route for pre-paginated rendering
- Fixed-height page containers with explicit padding/margins
- Read-only Tiptap renderer consuming page fragments
- `@page` CSS rules to remove browser headers/footers
- Auto-triggers `window.print()` when ready

#### 4. Print Handler (updated)
- Opens print route in new tab
- Shows loading state during computation
- Stable DOM detection before triggering print
- Fallback handling for computation errors

### Key Design Decisions

✅ **Pre-pagination over CSS tricks**: Each page is an independent container with explicit dimensions and spacing
✅ **Web Worker for performance**: 50+ page documents don't freeze UI
✅ **Caching for consistency**: Same content hash = identical output, every time
✅ **Browser-native print**: Preserves vector text, ligatures, true typography (no canvas/PDF generation)
✅ **Measurement-based splitting**: Uses actual rendered heights, not estimates

### Technical Constraints

**Dual-Editing Architecture**:
- Tiptap (rich text) → serializes to HTML → Prettier (formats to lines) → Monaco (AI edits) → back to Tiptap
- Pagination decorations show boundaries in Tiptap but are visual-only
- Print sees the underlying HTML without decoration metadata

**The Solution**: Compute actual break points from HTML and render pre-paginated print surface.

---

## User Persona

### Google Docs User Who Needs to Print

**Characteristics**:
- Creating any document that needs professional print output
- Examples: resumes, reports, proposals, letters, articles, academic papers
- Switched to pagination view specifically because they need print-ready output
- Expects WYSIWYG: what they see in pagination view = what they get when printing

**Example Users**:
- Job seeker formatting resume
- Business analyst creating reports
- Consultant writing proposals
- Writer drafting articles
- Student completing assignments
- Researcher preparing papers

---

## User Journey

### Current (Broken) Journey

1. User needs print-ready document
2. User switches to pagination view to see page boundaries
3. User edits content, using visual boundaries as guide
4. User clicks Print
5. **Print output has different page breaks than editor** 😡
6. User loses trust in pagination view

### Desired Journey

#### 1. User Enters Pagination View
- User creates/opens document and switches to pagination view
- Editor displays page boundaries, header/footer zones, margins
- User sees exactly how content will appear when printed

#### 2. User Edits Content with Page Awareness
- User writes/edits while seeing real-time page boundaries
- Pagination decorations update as content flows
- User can make informed decisions about layout

#### 3. User Initiates Print
- User clicks Print button (or Cmd/Ctrl+P)
- System immediately shows "Preparing print preview..." loading state
- New tab opens to `/print/[pageId]`

#### 4. System Computes Pagination (Background)
- Web Worker receives document JSON + pagination config
- Worker walks DOM tree, measuring content against page height
- Worker identifies exact break points, respecting node semantics
- Worker returns break metadata (or retrieves from cache if unchanged)

#### 5. System Renders Pre-Paginated Surface
- Print route renders fixed-height page containers
- Each container receives content fragment from worker
- Pages have explicit padding matching editor (top/bottom/left/right)
- `page-break-after: always` ensures clean breaks

#### 6. Browser Print Dialog Opens
- `MutationObserver` waits for stable DOM (fonts loaded, no reflows)
- System auto-triggers `window.print()`
- User sees accurate print preview matching editor exactly
- User can adjust printer settings (paper size, color, etc.)

#### 7. User Gets Expected Output
- Printed/PDF output matches what user saw in editor
- Page breaks occur at exact positions shown in pagination view
- Margins, spacing, typography all preserved
- User's trust in pagination view is confirmed ✅

---

## User Stories & Requirements

### Story 1: Print Route with Pre-Paginated Rendering

> As a document creator using pagination view, I want the system to compute exact page breaks and render them in fixed containers, so that print output matches what I see in the editor

**Pain Point**: Print output doesn't match editor boundaries
- Impact: 10/10 (complete feature failure)
- Frequency: 10/10 (every print attempt)
- Priority: 100/100 (P0)

**Functional Requirements**:
- Given a document in pagination view, when I click Print, then system should open `/print/[pageId]` in new tab
- Given the print route loads, when pagination is computing, then system should show loading indicator
- Given break metadata is computed, when rendering, then each page should be a fixed-height container with explicit dimensions
- Given page containers are rendered, when browser print dialog opens, then preview should show content matching editor exactly

---

### Story 2: Web Worker Pagination Engine

> As the system, I want to compute pagination in a background worker, so that large documents don't freeze the UI during print preparation

**Pain Point**: Long documents cause UI freezing during print
- Impact: 7/10 (blocks users with large documents)
- Frequency: 6/10 (affects subset of users)
- Priority: 42/100 (High)

**Functional Requirements**:
- Given a document with 50+ pages, when computing pagination, then UI should remain responsive
- Given pagination is computing, when complete, then worker should return break metadata array
- Given content hasn't changed, when printing again, then system should use cached results
- Given content has changed, when printing, then system should recompute and update cache

---

### Story 3: Node-Level Content Splitting

> As a document creator with complex content (lists, tables, images), I want the pagination engine to handle all content types correctly, so that nothing gets awkwardly cut across pages

**Pain Point**: Complex content gets mangled across page breaks
- Impact: 9/10 (creates unprofessional output)
- Frequency: 8/10 (common in real documents)
- Priority: 72/100 (Critical)

**Functional Requirements**:
- Given a paragraph spans pages, when splitting, then system should break at word boundaries
- Given a list spans pages, when splitting, then system should preserve list semantics and indentation
- Given a table spans pages, when splitting, then system should break between rows (not mid-row)
- Given an image/code block doesn't fit, when splitting, then system should move entire element to next page
- Given nested content (list in list), when splitting, then system should maintain hierarchy

---

### Story 4: Typography & Style Preservation

> As a document creator with formatted content, I want print output to preserve all typography and styling exactly as shown in the editor, so that my document looks professional

**Pain Point**: Print degrades typography and loses formatting
- Impact: 8/10 (unprofessional output)
- Frequency: 7/10 (affects styled documents)
- Priority: 56/100 (High)

**Functional Requirements**:
- Given the editor uses custom fonts, when printing, then system should preload all fonts before triggering print
- Given content has colors/backgrounds, when printing, then system should preserve them (`print-color-adjust: exact`)
- Given content has ligatures/kerning, when printing, then browser should use vector text rendering (not canvas)
- Given content has semantic formatting (bold, italic, code), when printing, then all formatting should be preserved

---

### Story 5: Deterministic Output & Caching

> As a user printing the same document multiple times, I want the output to be identical every time, so that I can trust the system for version control and archival

**Pain Point**: Inconsistent print output across attempts
- Impact: 6/10 (breaks trust, confuses version tracking)
- Frequency: 5/10 (affects repeat printers)
- Priority: 30/100 (Medium)

**Functional Requirements**:
- Given a document hasn't changed, when printing multiple times, then break points should be identical
- Given break metadata is computed, when storing in cache, then system should key by content hash
- Given cached results exist, when printing, then system should skip recomputation
- Given content changes by one character, when printing, then system should recompute (cache miss)

---

## Implementation Phases

### Phase 1: Foundation (Paragraphs & Headings)
**Goal**: Prove the approach works with basic text nodes

**Deliverables**:
- Core pagination engine with basic text nodes
- Measurement logic with `getClientRects()`
- Print route with fixed-height containers
- Basic print handler integration

**Testing**: Simple documents (no lists/tables/images)

---

### Phase 2: Complex Block Nodes (Lists, Tables, Code Blocks)
**Goal**: Handle real-world document complexity

**Deliverables**:
- List nesting and semantic preservation
- Table row-aware splitting
- Code blocks as atomic units
- Extended node type support

**Testing**: Realistic business documents with mixed content

---

### Phase 3: Media & Embeds (Images, Videos, Iframes)
**Goal**: Support rich media content

**Deliverables**:
- Atomic image handling (never split)
- Overflow cases (content too tall for page)
- Embedded content support (iframes, widgets)
- Media-specific layout rules

**Testing**: Media-rich documents (presentations, reports with charts)

---

### Phase 4: Web Worker & Caching
**Goal**: Achieve production-grade performance

**Deliverables**:
- Web Worker wrapper for pagination engine
- IndexedDB caching by content hash
- Cache invalidation logic
- Performance monitoring

**Testing**: 100+ page documents, repeated print operations

---

### Phase 5: Polish & Edge Cases
**Goal**: Ship-ready quality

**Deliverables**:
- Typography preloading system
- Print CSS refinement (`@page`, color adjustment)
- Error handling and fallbacks
- Accessibility review (selectable, searchable output)

**Testing**: Edge cases, error scenarios, accessibility audit

---

### Phase 6: Production Hardening
**Goal**: Confidence for production deployment

**Deliverables**:
- Visual regression test suite (screenshot comparison)
- Unit tests for pagination logic per node type
- Integration tests for full print flow
- Performance benchmarks and optimization

**Testing**: Full QA pass, beta user testing

---

## Scope Decisions

### In Scope (MVP)

✅ **8.5x11 Letter size only** - Validate approach before adding custom sizes
✅ **All node types** - Paragraphs → complex blocks → media (Phases 1-5)
✅ **Web Worker + caching** - Production-grade performance
✅ **Ephemeral print routes** - No permanent links to print versions
✅ **Fully automatic** - Zero user configuration, magical behavior
✅ **Print current state** - No editing locks during print

### Out of Scope (Post-MVP)

❌ **Custom page sizes** - A4, Legal, custom dimensions (Phase 6+)
❌ **Manual break controls** - User-specified "keep together" hints
❌ **Print preview mode** - Print route IS the preview
❌ **Permanent print URLs** - Print routes are session-only
❌ **Print settings UI** - Users adjust settings in browser print dialog

---

## Success Metrics

### Primary Metric: Print Fidelity
- **Target**: 100% of page breaks in print match editor decorations (±5px tolerance)
- **Measure**: Visual regression tests pass for all supported node types
- **Indicator**: Zero user reports of "print doesn't match editor"

### Secondary Metrics

**Performance**:
- Pagination computation completes in <2s for 50-page documents
- Cache hit rate >80% for repeat prints
- UI remains responsive during computation (no jank)

**Adoption**:
- Pagination view usage increases by >50% post-launch
- Print button click-through rate >30% of pagination view sessions

**Quality**:
- User satisfaction rating for print feature >4.5/5
- <5% error rate in print flow (computation failures, render errors)

---

## Testing Strategy

### 1. Visual Regression Testing
- Screenshot editor view vs print output
- Diff images for pixel-perfect comparison
- Automated alerts on visual changes
- Cover all node types and edge cases

### 2. Unit Tests
- Test pagination logic for each node type in isolation
- Mock DOM measurement APIs
- Verify break point calculations
- Test edge cases (empty nodes, very long words, etc.)

### 3. Integration Tests
- Full print flow from button click to dialog
- Worker communication and caching
- Error handling and fallbacks
- Cross-browser compatibility

### 4. Performance Benchmarks
- Track computation time across document sizes
- Monitor cache hit rates
- Profile memory usage
- Identify optimization opportunities

### 5. User Testing
- Beta test with real documents before production
- Gather feedback on accuracy and performance
- Identify missing features or bugs
- Validate success metrics

---

## Technical Architecture

See [print-pagination-architecture.md](./print-pagination-architecture.md) for detailed technical design.

**Key Files**:
- `page-breaker.ts`: Core pagination algorithm
- `page-breaker.worker.ts`: Web Worker wrapper
- `app/print/[pageId]/page.tsx`: Print route
- `TiptapRenderer.tsx`: Read-only content renderer
- `print-handler.ts`: Print trigger and loading state

---

## Risks & Mitigations

### Risk 1: Browser Inconsistencies
**Impact**: High - Print output differs across browsers
**Mitigation**: Test on Chrome, Firefox, Safari; use standardized CSS

### Risk 2: Font Loading Timing
**Impact**: Medium - Fonts load after pagination computed, causing reflow
**Mitigation**: Preload all fonts, wait for stable DOM before print trigger

### Risk 3: Performance on Large Documents
**Impact**: Medium - 200+ page documents may timeout
**Mitigation**: Web Worker prevents UI freeze; optimize algorithm; consider streaming

### Risk 4: Complex Node Edge Cases
**Impact**: Medium - Unexpected content breaks incorrectly
**Mitigation**: Comprehensive test suite covering all node types; fallback to atomic handling

### Risk 5: Cache Invalidation Bugs
**Impact**: Low - Stale cache causes incorrect output
**Mitigation**: Content hash keying; version cache schema; expose cache clear in dev tools

---

## Timeline Estimate

**Phase 1-2** (Foundation + Complex Nodes): 2-3 weeks
**Phase 3** (Media & Embeds): 1-2 weeks
**Phase 4** (Worker + Caching): 1-2 weeks
**Phase 5** (Polish): 1 week
**Phase 6** (Testing & Hardening): 2 weeks

**Total**: 7-10 weeks for complete implementation and testing

**Critical Path**: Phase 1 → Phase 2 → Phase 4 (must prove approach, handle real content, achieve performance)

---

## Open Questions (RESOLVED)

**Q1: Custom page sizes?**
✅ Yes, but post-MVP (Phase 6+). Ship with 8.5x11 Letter only initially.

**Q2: Separate print preview mode?**
✅ No. The print route IS the preview. Compute cost is acceptable.

**Q3: Permanent print URLs?**
✅ No. Print routes are ephemeral (session-only).

**Q4: Editing during print?**
✅ Print current state. No editing locks.

**Q5: Manual break controls?**
✅ No. Fully automatic (magical). Bar is Google Docs level.

---

## References

- [Print Pagination Architecture](./print-pagination-architecture.md)
- [UI Refresh Protection](./ui-refresh-protection.md)
- PageSpace monorepo structure: `apps/web/src/`

---

**Last Updated**: 2025-10-24
**Next Review**: After Phase 1 completion
