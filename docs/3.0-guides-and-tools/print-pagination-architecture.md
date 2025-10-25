# Print Pagination Architecture

## Problem Statement

Browser print with continuous DOM elements cannot achieve consistent page spacing. CSS `padding-top` applies only at element start (page 1), not at internal page breaks. Result: page 2+ lacks top/bottom margins.

## Solution: Pre-Paginated Print Surface

Build dedicated print route with sophisticated pagination engine that splits content at exact boundaries before browser print dialog.

## Core Architecture

### 1. Pagination Engine
**Purpose**: Deterministic content splitting using DOM measurement

**Mechanism**:
- Hidden measurement container mirrors editor styles
- Walk ProseMirror DOM with `DOMRange` + `getClientRects()`
- Track cumulative height per page against `pageContentAreaHeight`
- Split nodes at boundaries using `Range.splitText()` / `Range.extractContents()`
- Generate break metadata: `{ pageIndex, nodeId, offset }[]`

**Key Principle**: Reuse editor's layout constants (margins, header/footer heights) for measurement parity

### 2. Web Worker Offloading
**Purpose**: Maintain UI responsiveness during pagination of 50+ page documents

**Flow**:
- Accept: ProseMirror JSON + pagination config
- Process: Run pagination algorithm
- Return: Break metadata + page content fragments
- Cache: Store results by revision hash in IndexedDB

**Benefit**: Repeated prints are instantaneous and deterministic

### 3. Print Route (`/print/[pageId]`)
**Purpose**: Render pre-paginated content in fixed-height containers

**Structure**:
- Each page = isolated container with explicit dimensions
- Fixed height matches editor's calculated page height
- Explicit padding (margins + header/footer space) per container
- `page-break-after: always` on each container
- No editor chrome, only content + spacing

**Rendering**: Use read-only Tiptap renderer consuming page fragments from worker

### 4. Print CSS
**Requirements**:
- `@page { size: 8.5in 11in; margin: 0 }` removes browser headers/footers
- `-webkit-print-color-adjust: exact` preserves colors
- `font-display: block` prevents reflow during font loading
- Preload all fonts before pagination

### 5. Print Trigger
**Flow**:
- User clicks Print button
- Opens `/print/[pageId]` in new tab
- Shows loading state while worker processes
- `MutationObserver` waits for stable DOM
- Auto-triggers `window.print()`

## Why This Beats Alternatives

### vs. Canvas/PDF Rasterization
- **html2canvas**: Degrades fonts, struggles with complex styles, blurs high-DPI
- **jsPDF + canvas**: Balloons bundle (100s KB), stalls on large docs, produces multi-MB bitmaps
- **Browser native print**: Preserves vector text, ligatures, selectable content, true typography

### vs. Simple Fixed-Height Divs
- **Node splitting**: Handles nested elements (lists, tables) correctly
- **DOMRange splitting**: Respects inline formatting across boundaries
- **Measurement-based**: Uses actual rendered heights, not estimated values

### vs. CSS-Only Approaches
- **Sidesteps padding limitation**: Each page is independent element with explicit padding
- **Deterministic breaks**: Computed algorithmically, not browser-dependent
- **Preview-able**: Exact output visible before print dialog

## Quality Guarantees

1. **Determinism**: Cached break metadata ensures identical output across prints
2. **Node-level fidelity**: Splitting respects semantic HTML structure
3. **Typography preservation**: Vector fonts, ligatures, subpixel rendering intact
4. **Responsive processing**: Worker prevents UI blocking
5. **1:1 editor matching**: Shared layout constants eliminate drift

## Implementation Phases

**Phase 1**: Build pagination engine with basic node types (paragraphs, headings)
**Phase 2**: Create print route with fixed-height page containers
**Phase 3**: Wrap engine in Web Worker with caching
**Phase 4**: Add Print button + preview mode
**Phase 5**: Extend to complex nodes (tables, lists, images, embeds)

## Testing Strategy

- Serialize break metadata and diff across releases (regression detection)
- Unit test pagination logic per node type
- Visual regression: screenshot each page, compare against baseline
- Performance benchmark: measure worker time for 50+ page documents

## Comparison: Google Docs Approach

Google Docs likely:
- Maintains separate paginated model from editing surface
- Uses canvas for editing but DOM for print (preserves vector text)
- Caches deterministic measurement data with document revision
- Strips browser headers via `@page` rules
- Injects custom header/footer inside page containers

## Key Files

- `page-breaker.ts`: Core pagination algorithm
- `page-breaker.worker.ts`: Web Worker wrapper
- `app/print/[pageId]/page.tsx`: Print route
- `TiptapRenderer.tsx`: Read-only content renderer
- `print-handler.ts`: Simplified to trigger print route
