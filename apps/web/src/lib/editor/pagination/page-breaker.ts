/**
 * Page Breaker - Core Pagination Calculation Module
 *
 * Pure, testable pagination algorithm extracted from print-handler.ts.
 * This module calculates exact page break positions using height-based
 * measurement, matching the visual pagination decorations exactly.
 *
 * ## Design Principles
 * - Pure functions with no DOM side effects
 * - Returns structured metadata instead of modifying DOM
 * - Testable in isolation without browser environment
 * - Reusable across print handler, Web Worker, and print route
 *
 * ## Core Algorithm
 * 1. Iterate through content elements in order
 * 2. Track cumulative offsetHeight of elements
 * 3. When element would overflow page boundary, record break point before it
 * 4. Reset height tracking for new page
 *
 * This matches PaginationExtension's decoration logic exactly, ensuring 1:1 fidelity.
 */

/**
 * Metadata about a single page break location
 */
export interface PageBreakMetadata {
  /** Zero-indexed page number this break creates */
  pageIndex: number;
  /** Index of the content element where break occurs (break is BEFORE this element) */
  elementIndex: number;
  /** Cumulative height of previous page (for debugging/validation) */
  previousPageHeight: number;
  /** Height of the element that triggered the break */
  triggerElementHeight: number;
}

/**
 * Configuration for page break calculation
 * Matches PaginationPrintConfig but only includes values needed for calculation
 */
export interface PageBreakConfig {
  /** Available height for content on each page (excludes margins, headers, footers) */
  pageContentAreaHeight: number;
  /** Tolerance in pixels for page overflow detection (prevents early breaks) */
  overflowTolerance?: number;
}

/**
 * Calculates page break positions using height-based measurement
 *
 * Given a list of content elements and page configuration, determines
 * exactly where page breaks should occur to match visual pagination.
 *
 * @param contentElements - Array of HTML elements representing document content in order
 * @param config - Page break configuration with content area height
 * @returns Array of break metadata, one entry per page break
 *
 * @example
 * ```typescript
 * const elements = Array.from(editor.querySelectorAll('.ProseMirror > *'));
 * const config = { pageContentAreaHeight: 800 };
 * const breaks = calculatePageBreaks(elements, config);
 * // breaks[0] = { pageIndex: 1, elementIndex: 5, previousPageHeight: 795, triggerElementHeight: 120 }
 * ```
 */
export function calculatePageBreaks(
  contentElements: HTMLElement[],
  config: PageBreakConfig
): PageBreakMetadata[] {
  const breaks: PageBreakMetadata[] = [];

  if (contentElements.length === 0) {
    return breaks;
  }

  const pageContentAreaHeight = config.pageContentAreaHeight;
  const overflowTolerance = config.overflowTolerance ?? 10; // 10px default tolerance

  // Track cumulative height of current page
  let currentPageHeight = 0;
  let pageNumber = 1;

  // Iterate through content elements, calculating when to break
  for (let i = 0; i < contentElements.length; i++) {
    const element = contentElements[i];
    const elementHeight = element.offsetHeight;

    // Check if this element would overflow the current page
    // Use tolerance to prevent breaking too early due to minor rounding differences
    const wouldOverflow = currentPageHeight + elementHeight > pageContentAreaHeight + overflowTolerance;
    const hasContent = currentPageHeight > 0;

    if (wouldOverflow && hasContent) {
      // This element doesn't fit on current page - record break BEFORE it
      breaks.push({
        pageIndex: pageNumber,
        elementIndex: i,
        previousPageHeight: currentPageHeight,
        triggerElementHeight: elementHeight,
      });

      pageNumber++;

      // This element starts a new page
      currentPageHeight = elementHeight;
    } else {
      // Element fits on current page
      currentPageHeight += elementHeight;
    }
  }

  return breaks;
}

/**
 * Extracts content elements from editor DOM, filtering out pagination decorations
 *
 * @param editorElement - The root editor element containing ProseMirror content
 * @returns Array of content elements in document order
 */
export function extractContentElements(editorElement: HTMLElement): HTMLElement[] {
  // Get all ProseMirror content elements (actual content, not decorations)
  const proseMirrorContent = editorElement.querySelectorAll(
    '.ProseMirror > *:not([data-rm-pagination]):not(.rm-first-page-header)'
  );

  return Array.from(proseMirrorContent) as HTMLElement[];
}
