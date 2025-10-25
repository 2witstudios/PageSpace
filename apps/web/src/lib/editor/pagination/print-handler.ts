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
 * Injects temporary page break elements into content using height-based calculation
 *
 * Strategy: Use the SAME algorithm as PaginationExtension to calculate break positions
 * - Iterate through content elements in order
 * - Track cumulative offsetHeight
 * - When cumulative height exceeds pageContentAreaHeight, inject break BEFORE that element
 * - This guarantees 1:1 matching because we use identical math to the pagination extension
 * - CSS padding provides spacing on every page automatically
 *
 * Returns array of injected elements for cleanup
 */
function injectContentPageBreaks(
  editorElement: HTMLElement,
  config: PaginationPrintConfig
): HTMLElement[] {
  const injectedElements: HTMLElement[] = [];

  // Get all ProseMirror content elements (actual content, not decorations)
  const proseMirrorContent = editorElement.querySelectorAll(
    '.ProseMirror > *:not([data-rm-pagination]):not(.rm-first-page-header)'
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

  // Inject page break elements at calculated positions
  for (const breakMeta of breaks) {
    const element = contentElements[breakMeta.elementIndex];

    if (element && element.parentNode) {
      const pageBreakDiv = document.createElement('div');
      pageBreakDiv.className = 'temp-print-page-break';
      pageBreakDiv.style.pageBreakBefore = 'always';
      pageBreakDiv.style.breakBefore = 'page';
      pageBreakDiv.style.height = '0';
      pageBreakDiv.style.margin = '0';
      pageBreakDiv.style.padding = '0';
      pageBreakDiv.setAttribute('data-temp-print', 'true');

      element.parentNode.insertBefore(pageBreakDiv, element);
      injectedElements.push(pageBreakDiv);

      loggers.performance.debug('Injected page break', {
        pageIndex: breakMeta.pageIndex,
        elementIndex: breakMeta.elementIndex,
        previousPageHeight: breakMeta.previousPageHeight,
        triggerElementHeight: breakMeta.triggerElementHeight,
        threshold: pageContentAreaHeight + 10,
      });
    }
  }

  loggers.performance.info('Height-based pagination complete', {
    pageBreaksInjected: injectedElements.length,
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

  // Calculate total padding from config values
  const totalPaddingTop = config.marginTop + config.pageHeaderHeight + config.contentMarginTop;
  const totalPaddingBottom = config.marginBottom + config.pageFooterHeight + config.contentMarginBottom;

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

      /* Temporary page breaks injected by JavaScript - ensure they work */
      .temp-print-page-break {
        page-break-before: always !important;
        break-before: page !important;
        height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
      }

      /* Preserve editor container styling */
      .rm-with-pagination {
        border: none !important;
        box-shadow: none !important;
        background: white !important;
      }

      /* Apply padding to content - this creates spacing on EVERY page */
      .ProseMirror {
        padding-top: ${totalPaddingTop}px !important;
        padding-bottom: ${totalPaddingBottom}px !important;
        padding-left: ${config.marginLeft}px !important;
        padding-right: ${config.marginRight}px !important;
        max-width: 100% !important;
        overflow: visible !important;
        background: white !important;
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

  // Inject temporary page break elements into content using height-based calculation
  const injectedBreaks = injectContentPageBreaks(editorElement, config);

  // Inject print styles
  const styleElement = injectPrintStyles(config);

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
