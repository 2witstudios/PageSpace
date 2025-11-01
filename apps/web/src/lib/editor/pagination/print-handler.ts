/**
 * Print Handler for Paginated Documents
 *
 * This module ensures print output matches the paginated editor view exactly (1:1)
 * by using the same height-based calculation algorithm as the PaginationExtension.
 *
 * ## Approach: Height-Based Content Calculation
 *
 * The pagination extension creates visual decorations (at position 0) with CSS margins
 * to show where page boundaries occur. These decorations are NOT part of content flow
 * and use position-based rendering that becomes invalid when hidden for print.
 *
 * For 1:1 print matching, this handler:
 * 1. Reads `pageContentAreaHeight` from CSS variable (same value PaginationExtension uses)
 * 2. Iterates through ProseMirror content elements in order
 * 3. Tracks cumulative `offsetHeight` of elements on current page
 * 4. When element would overflow page, injects `<div style="page-break-before: always">` before it
 * 5. Hides all pagination decorations (editor-only visual aids)
 * 6. Applies @page CSS with exact configured dimensions
 * 7. Triggers print dialog
 * 8. Cleans up by removing all injected elements and styles
 *
 * ## Why This Guarantees 1:1 Matching
 * - Uses identical `pageContentAreaHeight` calculation as PaginationExtension
 * - Element `offsetHeight` is stable regardless of decoration visibility
 * - Content-based iteration matches exactly how pagination calculates pages
 * - No dependency on `getBoundingClientRect()` which changes when decorations hide
 *
 * ## Key Features
 * - True 1:1 matching: breaks at exact same positions as editor view
 * - Non-permanent: DOM modifications are temporary (only during print)
 * - Config-aware: reads page size, margins, headers/footers from CSS variables
 * - Clean output: hides all UI chrome and pagination decorations
 * - Automatic cleanup: removes all injected elements after printing
 */

import { calculatePageBreaks } from './page-breaker';
import { browserLoggers } from '@pagespace/lib/logger-browser';

// Use browser-safe logger to prevent server-side code bundling into client
// This file is imported by ExportDropdown.tsx which is a client component
const loggers = browserLoggers;

interface PaginationPrintConfig {
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  pageHeaderHeight: number;
  pageFooterHeight: number;
  contentMarginTop: number;
  contentMarginBottom: number;
  pageGapBorderColor: string;
  pageContentAreaHeight: number; // Calculated content area height for page breaks
}

/**
 * Extracts pagination configuration from CSS custom properties
 * on the editor DOM element
 */
function extractPaginationConfig(editorElement: HTMLElement): PaginationPrintConfig | null {
  // Check if pagination is active
  if (!editorElement.classList.contains('rm-with-pagination')) {
    return null;
  }

  const computedStyle = window.getComputedStyle(editorElement);

  const getCSSVar = (name: string): string | null => {
    const value = computedStyle.getPropertyValue(`--rm-${name}`);
    return value ? value.trim() : null;
  };

  const parsePixelValue = (value: string | null, fallback: number = 0): number => {
    if (!value) return fallback;
    const parsed = parseFloat(value.replace('px', ''));
    return isNaN(parsed) ? fallback : parsed;
  };

  // Extract all config values with proper fallbacks
  const pageWidth = parsePixelValue(getCSSVar('page-width'), 816); // US Letter width default
  const marginTop = parsePixelValue(getCSSVar('margin-top'), 96); // 1 inch default
  const marginBottom = parsePixelValue(getCSSVar('margin-bottom'), 96);
  const marginLeft = parsePixelValue(getCSSVar('margin-left'), 96);
  const marginRight = parsePixelValue(getCSSVar('margin-right'), 96);
  const pageHeaderHeight = parsePixelValue(getCSSVar('page-header-height'), 30);
  const pageFooterHeight = parsePixelValue(getCSSVar('page-footer-height'), 30);
  const contentMarginTop = parsePixelValue(getCSSVar('content-margin-top'), 10);
  const contentMarginBottom = parsePixelValue(getCSSVar('content-margin-bottom'), 10);

  // Get page content area height from CSS variable
  // This is already calculated by PaginationExtension using the formula:
  // pageHeight - (headerHeight + contentMarginTop + marginTop) - (footerHeight + contentMarginBottom + marginBottom)
  const contentHeightStr = getCSSVar('page-content-height');
  const pageContentAreaHeight = contentHeightStr ? parsePixelValue(contentHeightStr, 800) : 800;

  const config: PaginationPrintConfig = {
    pageWidth,
    pageHeight: 0, // We'll calculate this from content + margins
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    pageHeaderHeight,
    pageFooterHeight,
    contentMarginTop,
    contentMarginBottom,
    pageGapBorderColor: getCSSVar('page-gap-border-color') || '#e5e5e5',
    pageContentAreaHeight,
  };

  // Validate that we have reasonable values
  if (config.pageWidth < 100 || config.pageWidth > 5000) {
    loggers.performance.warn('Invalid page width detected, using default', {
      detectedWidth: config.pageWidth,
      defaultWidth: 816,
    });
    config.pageWidth = 816;
  }

  return config;
}

/**
 * Calculates the total page height including all margins and spacing
 */
function calculatePageHeight(config: PaginationPrintConfig): number {
  // Try to get content height from CSS variable
  const contentHeightStr = window.getComputedStyle(document.documentElement)
    .getPropertyValue('--rm-page-content-height')
    .replace('px', '')
    .trim();

  const contentHeight = parseFloat(contentHeightStr) || 800; // US Letter height minus margins default

  const totalHeight = (
    config.marginTop +
    config.pageHeaderHeight +
    config.contentMarginTop +
    contentHeight +
    config.contentMarginBottom +
    config.pageFooterHeight +
    config.marginBottom
  );

  // Validate reasonable page height (between 400px and 5000px)
  if (totalHeight < 400 || totalHeight > 5000) {
    loggers.performance.warn('Calculated page height out of range, using default', {
      calculatedHeight: totalHeight,
      defaultHeight: 1056,
    });
    return 1056; // US Letter height default
  }

  return totalHeight;
}

/**
 * Finds all page break decoration elements in the editor
 */
function findPageBreaks(editorElement: HTMLElement): HTMLElement[] {
  const paginationContainer = editorElement.querySelector('[data-rm-pagination]');
  if (!paginationContainer) {
    return [];
  }

  const pageBreaks = Array.from(
    paginationContainer.querySelectorAll('.rm-page-break')
  ) as HTMLElement[];

  return pageBreaks;
}

/**
 * Creates a page wrapper div with proper padding for print output
 * Uses inline styles for maximum specificity to override globals.css
 */
function createPageWrapper(config: PaginationPrintConfig): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'print-page';
  wrapper.setAttribute('data-temp-print', 'true');

  // Calculate total padding
  const paddingTop = config.marginTop + config.pageHeaderHeight + config.contentMarginTop;
  const paddingBottom = config.marginBottom + config.pageFooterHeight + config.contentMarginBottom;

  // Use cssText for comprehensive inline styles that override everything
  // Inline styles have highest specificity and always win over class-based CSS
  // CRITICAL: Use margin for vertical spacing, padding for horizontal
  // CSS page breaks collapse padding at fragmentation boundaries but preserve margins
  wrapper.style.cssText = `
    box-sizing: border-box !important;
    display: block !important;
    width: 100% !important;
    background: white !important;
    margin-top: ${paddingTop}px !important;
    margin-bottom: ${paddingBottom}px !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    padding-left: ${config.marginLeft}px !important;
    padding-right: ${config.marginRight}px !important;
  `;

  return wrapper;
}

/**
 * Wraps content segments between page breaks into individual page containers
 * This ensures padding applies per-page instead of accumulating across breaks
 */
function wrapContentIntoPages(
  contentElements: HTMLElement[],
  breaks: Array<{ elementIndex: number; pageIndex: number; previousPageHeight: number; triggerElementHeight: number }>,
  config: PaginationPrintConfig,
  proseMirrorContainer: HTMLElement
): HTMLElement[] {
  const pageWrappers: HTMLElement[] = [];
  let currentElementIndex = 0;

  // Process each page
  for (let pageIndex = 0; pageIndex <= breaks.length; pageIndex++) {
    const isLastPage = pageIndex === breaks.length;
    const wrapper = createPageWrapper(config);

    // Determine end index for this page
    const endIndex = isLastPage
      ? contentElements.length
      : breaks[pageIndex].elementIndex;

    // Move elements from current index to end index into wrapper
    while (currentElementIndex < endIndex) {
      const element = contentElements[currentElementIndex];
      if (element && element.parentNode === proseMirrorContainer) {
        wrapper.appendChild(element);
      }
      currentElementIndex++;
    }

    // Only add wrapper if it has content
    if (wrapper.children.length > 0) {
      pageWrappers.push(wrapper);
    }
  }

  return pageWrappers;
}

/**
 * Injects page wrapper elements into content using height-based calculation
 *
 * Strategy: Use the SAME algorithm as PaginationExtension to calculate break positions,
 * then wrap content segments between breaks into individual page containers.
 * - Calculate break positions using identical math to pagination extension
 * - Wrap content between breaks in .print-page containers
 * - Each wrapper has its own padding (prevents accumulation)
 * - This guarantees 1:1 matching with paginated editor view
 *
 * Returns array of injected wrapper elements for cleanup
 */
function injectContentPageBreaks(
  editorElement: HTMLElement,
  config: PaginationPrintConfig
): HTMLElement[] {
  const injectedElements: HTMLElement[] = [];

  // Get ProseMirror container
  const proseMirrorContainer = editorElement.querySelector('.ProseMirror') as HTMLElement;
  if (!proseMirrorContainer) {
    loggers.performance.warn('ProseMirror container not found');
    return injectedElements;
  }

  // Get all ProseMirror content elements (actual content, not decorations)
  const proseMirrorContent = proseMirrorContainer.querySelectorAll(
    ':scope > *:not([data-rm-pagination]):not(.rm-first-page-header)'
  );
  const contentElements = Array.from(proseMirrorContent) as HTMLElement[];

  if (contentElements.length === 0) {
    loggers.performance.warn('No content elements found for pagination');
    return injectedElements;
  }

  const pageContentAreaHeight = config.pageContentAreaHeight;

  loggers.performance.info('Starting height-based pagination calculation', {
    pageContentAreaHeight,
    elementCount: contentElements.length,
  });

  // Use refactored calculatePageBreaks() for break calculation
  const breaks = calculatePageBreaks(contentElements, {
    pageContentAreaHeight,
    overflowTolerance: 10,
  });

  loggers.performance.info('Wrapping content into page containers', {
    pageBreaksCalculated: breaks.length,
    totalPages: breaks.length + 1,
  });

  // Wrap content segments into page containers
  const pageWrappers = wrapContentIntoPages(contentElements, breaks, config, proseMirrorContainer);

  // Insert wrappers back into ProseMirror container
  pageWrappers.forEach(wrapper => {
    proseMirrorContainer.appendChild(wrapper);
    injectedElements.push(wrapper);
  });

  loggers.performance.info('Height-based pagination complete', {
    pageWrappersCreated: pageWrappers.length,
    totalPages: breaks.length + 1,
  });

  return injectedElements;
}

/**
 * Injects CSS rules for clean print output with exact page dimensions
 * Hides all pagination decorations and applies configured page settings
 */
function injectPrintStyles(config: PaginationPrintConfig): HTMLStyleElement {
  const styleId = 'pagination-print-styles';

  // Clean up any existing pagination print styles to prevent conflicts
  const existingStyles = document.querySelectorAll(`#${styleId}, style[data-pagination-print]`);
  existingStyles.forEach(el => el.remove());

  const style = document.createElement('style');
  style.id = styleId;
  style.setAttribute('data-pagination-print', 'true');

  const pageHeight = calculatePageHeight(config);

  // Convert pixels to CSS measurements for @page (use mm for better print compatibility)
  const mmPerPixel = 0.264583; // 1px = 0.264583mm at 96 DPI
  const pageWidthMM = Math.round(config.pageWidth * mmPerPixel * 100) / 100;
  const pageHeightMM = Math.round(pageHeight * mmPerPixel * 100) / 100;

  style.textContent = `
    /* Pagination-aware print styles - Simplified approach */
    @media print {
      /* Use exact page size - NO margins to prevent browser headers/footers (URL, date, etc.) */
      @page {
        size: ${pageWidthMM}mm ${pageHeightMM}mm;
        margin: 0;
      }

      /* Reset body/html margins to prevent extra whitespace */
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        height: auto !important;
      }

      /* Hide all PageSpace application UI chrome */
      header, nav, aside,
      [class*="sidebar"],
      [class*="Sidebar"],
      [class*="header"],
      [class*="Header"],
      [class*="toolbar"],
      [class*="Toolbar"],
      button,
      [role="navigation"],
      [role="banner"] {
        display: none !important;
      }

      /* CRITICAL: Hide ALL pagination decoration widgets - they're editor-only visual aids */
      [data-rm-pagination],
      .rm-first-page-header,
      .rm-page-break,
      .rm-page-header,
      .rm-page-footer,
      .rm-pagination-gap {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        position: absolute !important;
        left: -9999px !important;
      }

      /* Preserve editor container styling */
      .rm-with-pagination {
        border: none !important;
        box-shadow: none !important;
        background: white !important;
      }

      /* CRITICAL: Override globals.css line 781 padding on .ProseMirror */
      /* Use direct child selector to target only .ProseMirror that contains .print-page */
      .rm-with-pagination.ProseMirror:has(.print-page),
      .rm-with-pagination .ProseMirror:has(.print-page),
      .ProseMirror:has([data-temp-print="true"]) {
        padding: 0 !important;
        margin: 0 !important;
        max-width: 100% !important;
        overflow: visible !important;
        background: white !important;
      }

      /* Ensure print-page wrappers render correctly without interference */
      /* The :has() selectors above already prevent globals.css padding from affecting these */
      .ProseMirror > .print-page,
      .ProseMirror > [data-temp-print="true"] {
        /* Let inline styles (set in createPageWrapper) handle all properties */
        /* Removed 'all: revert' which was stripping inline padding values */
        display: block !important;
        width: 100% !important;
        box-sizing: border-box !important;
      }

      /* Clean white background for print */
      .ProseMirror * {
        background: white !important;
      }

      /* Prevent orphaned headings and list items */
      h1, h2, h3, h4, h5, h6 {
        page-break-after: avoid !important;
        break-after: avoid !important;
      }

      /* Keep list items together when possible */
      li {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
    }
  `;

  document.head.appendChild(style);
  return style;
}

/**
 * Prepares the document for printing by injecting temporary page breaks and CSS
 * Returns a cleanup function to remove injected elements and styles
 */
export function preparePaginatedPrint(editorElement: HTMLElement): (() => void) | null {
  // Extract pagination config from editor
  const config = extractPaginationConfig(editorElement);
  if (!config) {
    loggers.performance.warn('Pagination not active - using default print behavior');
    return null;
  }

  // Find all calculated page breaks
  const pageBreaks = findPageBreaks(editorElement);
  if (pageBreaks.length === 0) {
    loggers.performance.warn('No page breaks found - document may be too short or pagination not initialized');
  }

  loggers.performance.info('Pagination print prepared', {
    pageBreaksFound: pageBreaks.length,
    pageWidth: config.pageWidth,
    pageContentAreaHeight: config.pageContentAreaHeight,
    calculatedPageHeight: calculatePageHeight(config),
  });

  // CRITICAL: Inject print styles FIRST before measuring heights
  // This ensures height calculations happen in the same CSS context as print output
  const styleElement = injectPrintStyles(config);

  // Force style computation by reading offsetHeight on any element
  // This ensures the injected CSS is fully applied before we measure
  void editorElement.offsetHeight;

  // Now inject page wrappers - heights will be measured with print CSS active
  const injectedBreaks = injectContentPageBreaks(editorElement, config);

  // Return cleanup function that removes both injected breaks and styles
  return () => {
    try {
      // Remove all injected page break elements
      injectedBreaks.forEach(breakEl => {
        if (breakEl && breakEl.parentNode) {
          breakEl.remove();
        }
      });

      // Remove style element
      if (styleElement && styleElement.parentNode) {
        styleElement.remove();
      }

      loggers.performance.info('Pagination print cleanup complete', {
        pageBreaksRemoved: injectedBreaks.length,
      });
    } catch (error) {
      loggers.performance.warn('Error cleaning up pagination print elements', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * High-level print function that handles preparation and cleanup automatically
 */
export async function printPaginatedDocument(editorElement: HTMLElement | null): Promise<void> {
  // Validate element exists and is in the DOM
  if (!editorElement || !document.contains(editorElement)) {
    loggers.performance.error('Cannot print: editor element not found or not attached to DOM');
    throw new Error('Editor element not available for printing');
  }

  const cleanup = preparePaginatedPrint(editorElement);

  try {
    // Trigger browser print dialog
    window.print();
  } finally {
    // Clean up after print dialog closes (or is cancelled)
    if (cleanup) {
      // Small delay to ensure print dialog has captured the styles
      // Use requestAnimationFrame for better timing
      requestAnimationFrame(() => {
        setTimeout(cleanup, 100);
      });
    }
  }
}
