/**
 * Tests for page-breaker.ts - Core Pagination Calculation
 *
 * These tests verify the height-based pagination algorithm that calculates
 * exact page break positions. The algorithm must match the visual pagination
 * decorations exactly to ensure 1:1 fidelity between editor and print output.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { calculatePageBreaks, extractContentElements, type PageBreakConfig } from '../page-breaker';

/**
 * Creates a mock HTMLElement with configurable offsetHeight for testing
 */
function createMockElement(height: number, tagName: string = 'P'): HTMLElement {
  const element = document.createElement(tagName);
  // Mock offsetHeight by defining it as a property
  Object.defineProperty(element, 'offsetHeight', {
    configurable: true,
    value: height,
  });
  return element;
}

describe('page-breaker', () => {
  describe('calculatePageBreaks', () => {
    const defaultConfig: PageBreakConfig = {
      pageContentAreaHeight: 800,
      overflowTolerance: 10,
    };

    it('returns empty array when no content elements', () => {
      const breaks = calculatePageBreaks([], defaultConfig);

      expect(breaks).toEqual([]);
    });

    it('returns no breaks for single element fitting on one page', () => {
      const elements = [createMockElement(400)];

      const breaks = calculatePageBreaks(elements, defaultConfig);

      expect(breaks).toHaveLength(0);
    });

    it('returns no breaks for multiple elements fitting on one page', () => {
      const elements = [
        createMockElement(200),
        createMockElement(300),
        createMockElement(250),
      ];

      const breaks = calculatePageBreaks(elements, defaultConfig);

      expect(breaks).toHaveLength(0);
    });

    describe('basic paragraph pagination', () => {
      it('creates page break when cumulative height exceeds page height', () => {
        // Page 1: 500px + 400px = 900px > 810px (800 + 10 tolerance)
        // Break should occur before element index 1
        const elements = [
          createMockElement(500), // Fits on page 1
          createMockElement(400), // Triggers break, starts page 2
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(1);
        expect(breaks[0]).toMatchObject({
          pageIndex: 1,
          elementIndex: 1,
          previousPageHeight: 500,
          triggerElementHeight: 400,
        });
      });

      it('creates multiple breaks across three pages', () => {
        // Page 1: 500px + 400px = 900px > 810px → break before element 1
        // Page 2: 400px + 500px = 900px > 810px → break before element 2
        // Page 3: 500px (fits)
        const elements = [
          createMockElement(500), // Page 1
          createMockElement(400), // Page 2 (triggers break #1)
          createMockElement(500), // Page 3 (triggers break #2)
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(2);

        // First break (page 1 → page 2)
        expect(breaks[0]).toMatchObject({
          pageIndex: 1,
          elementIndex: 1,
          previousPageHeight: 500,
        });

        // Second break (page 2 → page 3)
        expect(breaks[1]).toMatchObject({
          pageIndex: 2,
          elementIndex: 2,
          previousPageHeight: 400,
        });
      });

      it('handles many small elements across multiple pages', () => {
        // Each element is 100px, page fits 8 elements (800px)
        // Elements 0-7: Page 1 (800px)
        // Elements 8-15: Page 2 (break at element 8)
        // Elements 16-23: Page 3 (break at element 16)
        const elements = Array.from({ length: 24 }, () => createMockElement(100));

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(2);
        expect(breaks[0].elementIndex).toBe(8);
        expect(breaks[1].elementIndex).toBe(16);
      });

      it('uses overflow tolerance to prevent premature breaks', () => {
        // Without tolerance: 800px + 10px = 810px would break
        // With 10px tolerance: 800px + 10px = 810px ≤ 810px (fits)
        const elements = [
          createMockElement(800),
          createMockElement(10), // Should fit with tolerance
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(0);
      });

      it('breaks when exceeding tolerance threshold', () => {
        // 800px + 11px = 811px > 810px (800 + 10 tolerance)
        const elements = [
          createMockElement(800),
          createMockElement(11), // Should trigger break
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(1);
        expect(breaks[0].elementIndex).toBe(1);
      });
    });

    describe('heading pagination', () => {
      it('treats headings same as paragraphs for basic height calculation', () => {
        const elements = [
          createMockElement(500, 'H1'),
          createMockElement(400, 'P'), // Triggers break
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(1);
        expect(breaks[0].elementIndex).toBe(1);
      });

      it('handles mixed headings and paragraphs', () => {
        const elements = [
          createMockElement(60, 'H1'),  // Page 1
          createMockElement(200, 'P'),  // Page 1
          createMockElement(550, 'P'),  // Page 1 (total: 810px with tolerance)
          createMockElement(40, 'H2'),  // Page 2 (triggers break)
          createMockElement(400, 'P'),  // Page 2
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(1);
        expect(breaks[0].elementIndex).toBe(3); // Break before H2
      });

      it('handles very tall heading that spans most of page', () => {
        // Large heading that nearly fills page
        const elements = [
          createMockElement(750, 'H1'), // Large heading
          createMockElement(100, 'P'),  // Triggers break
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(1);
        expect(breaks[0].elementIndex).toBe(1);
      });
    });

    describe('edge cases', () => {
      it('handles first element taller than page height', () => {
        // Element taller than page - should not break (no previous content)
        const elements = [
          createMockElement(1000), // Taller than page
          createMockElement(200),
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        // First element doesn't cause break (currentPageHeight = 0)
        // Second element: 1000 + 200 = 1200 > 810 → break
        expect(breaks).toHaveLength(1);
        expect(breaks[0].elementIndex).toBe(1);
      });

      it('handles element taller than page in middle of document', () => {
        const elements = [
          createMockElement(500),  // Page 1
          createMockElement(1000), // Page 2 (triggers break, taller than page)
          createMockElement(200),  // Page 3 (triggers break)
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(2);
        expect(breaks[0].elementIndex).toBe(1); // Break before tall element
        expect(breaks[1].elementIndex).toBe(2); // Break after tall element
      });

      it('handles zero-height elements', () => {
        const elements = [
          createMockElement(500),
          createMockElement(0),   // Zero height (empty element)
          createMockElement(300),
          createMockElement(0),   // Zero height
          createMockElement(100), // Triggers break (500 + 0 + 300 + 0 + 100 = 900)
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(1);
        expect(breaks[0].elementIndex).toBe(4);
      });

      it('handles custom tolerance value', () => {
        const customConfig: PageBreakConfig = {
          pageContentAreaHeight: 800,
          overflowTolerance: 50, // Larger tolerance
        };

        // 800px + 50px = 850px ≤ 850px (should fit)
        const elements = [
          createMockElement(800),
          createMockElement(50), // Should fit with 50px tolerance
        ];

        const breaks = calculatePageBreaks(elements, customConfig);

        expect(breaks).toHaveLength(0);
      });

      it('handles zero tolerance', () => {
        const strictConfig: PageBreakConfig = {
          pageContentAreaHeight: 800,
          overflowTolerance: 0,
        };

        // 800px + 1px = 801px > 800px (should break)
        const elements = [
          createMockElement(800),
          createMockElement(1), // Should trigger break with 0 tolerance
        ];

        const breaks = calculatePageBreaks(elements, strictConfig);

        expect(breaks).toHaveLength(1);
        expect(breaks[0].elementIndex).toBe(1);
      });
    });

    describe('metadata validation', () => {
      it('returns correct metadata for each break', () => {
        const elements = [
          createMockElement(500), // Page 1
          createMockElement(400), // Page 2 (triggers break)
          createMockElement(500), // Page 3 (triggers break)
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        // First break
        expect(breaks[0].pageIndex).toBe(1);
        expect(breaks[0].elementIndex).toBe(1);
        expect(breaks[0].previousPageHeight).toBe(500);
        expect(breaks[0].triggerElementHeight).toBe(400);

        // Second break
        expect(breaks[1].pageIndex).toBe(2);
        expect(breaks[1].elementIndex).toBe(2);
        expect(breaks[1].previousPageHeight).toBe(400);
        expect(breaks[1].triggerElementHeight).toBe(500);
      });

      it('increments pageIndex correctly across breaks', () => {
        const elements = [
          createMockElement(500),
          createMockElement(400), // Break → page 1
          createMockElement(500), // Break → page 2
          createMockElement(500), // Break → page 3
        ];

        const breaks = calculatePageBreaks(elements, defaultConfig);

        expect(breaks).toHaveLength(3);
        expect(breaks[0].pageIndex).toBe(1);
        expect(breaks[1].pageIndex).toBe(2);
        expect(breaks[2].pageIndex).toBe(3);
      });
    });
  });

  describe('extractContentElements', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
    });

    it('extracts ProseMirror content elements', () => {
      document.body.innerHTML = `
        <div class="editor">
          <div class="ProseMirror">
            <p>Paragraph 1</p>
            <p>Paragraph 2</p>
            <h1>Heading</h1>
          </div>
        </div>
      `;

      const editor = document.querySelector('.editor') as HTMLElement;
      const elements = extractContentElements(editor);

      expect(elements).toHaveLength(3);
      expect(elements[0].tagName).toBe('P');
      expect(elements[1].tagName).toBe('P');
      expect(elements[2].tagName).toBe('H1');
    });

    it('excludes pagination decoration elements', () => {
      document.body.innerHTML = `
        <div class="editor">
          <div class="ProseMirror">
            <div data-rm-pagination>Decoration</div>
            <p>Paragraph 1</p>
            <div class="rm-first-page-header">Header</div>
            <p>Paragraph 2</p>
          </div>
        </div>
      `;

      const editor = document.querySelector('.editor') as HTMLElement;
      const elements = extractContentElements(editor);

      // Should only extract the 2 paragraphs, not decorations
      expect(elements).toHaveLength(2);
      expect(elements[0].tagName).toBe('P');
      expect(elements[1].tagName).toBe('P');
    });

    it('returns empty array when no ProseMirror container', () => {
      document.body.innerHTML = `<div class="editor"></div>`;

      const editor = document.querySelector('.editor') as HTMLElement;
      const elements = extractContentElements(editor);

      expect(elements).toEqual([]);
    });

    it('returns empty array when ProseMirror has no children', () => {
      document.body.innerHTML = `
        <div class="editor">
          <div class="ProseMirror"></div>
        </div>
      `;

      const editor = document.querySelector('.editor') as HTMLElement;
      const elements = extractContentElements(editor);

      expect(elements).toEqual([]);
    });
  });
});
