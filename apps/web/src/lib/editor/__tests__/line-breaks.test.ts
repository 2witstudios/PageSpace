import { describe, it, expect } from 'vitest';
import { addLineBreaksForAI } from '../line-breaks';

describe('addLineBreaksForAI', () => {
  describe('trailing space preservation', () => {
    it('preserves trailing spaces in text content', () => {
      const input = '<p>Hello </p>';
      const output = addLineBreaksForAI(input);
      expect(output).toContain('Hello '); // Space preserved
    });

    it('preserves multiple trailing spaces', () => {
      const input = '<p>Hello   </p>';
      const output = addLineBreaksForAI(input);
      expect(output).toContain('Hello   '); // Multiple spaces preserved
    });

    it('preserves leading spaces in text content', () => {
      const input = '<p>   Hello</p>';
      const output = addLineBreaksForAI(input);
      expect(output).toContain('   Hello'); // Leading spaces preserved
    });

    it('preserves runs of three or more blank lines', () => {
      const input = '<p>Line 1\n\n\nLine 2</p>';
      const output = addLineBreaksForAI(input);
      expect(output).toContain('Line 1\n\n\nLine 2');
    });
  });

  describe('line break insertion', () => {
    it('adds newlines after block-level opening tags', () => {
      const input = '<p>Text</p>';
      const output = addLineBreaksForAI(input);
      expect(output).toMatch(/<p>\n/);
    });

    it('adds newlines before block-level closing tags', () => {
      const input = '<p>Text</p>';
      const output = addLineBreaksForAI(input);
      expect(output).toMatch(/\n<\/p>/);
    });

    it('handles multiple block elements', () => {
      const input = '<p>First</p><p>Second</p>';
      const output = addLineBreaksForAI(input);
      const lines = output.split('\n');
      expect(lines.length).toBeGreaterThan(2);
    });

    it('handles headings', () => {
      const input = '<h1>Title</h1><h2>Subtitle</h2>';
      const output = addLineBreaksForAI(input);
      expect(output).toMatch(/<h1>\n/);
      expect(output).toMatch(/\n<\/h1>/);
      expect(output).toMatch(/<h2>\n/);
      expect(output).toMatch(/\n<\/h2>/);
    });

    it('handles lists', () => {
      const input = '<ul><li>Item 1</li><li>Item 2</li></ul>';
      const output = addLineBreaksForAI(input);
      expect(output).toMatch(/<ul>\n/);
      expect(output).toMatch(/<li>\n/);
      expect(output).toMatch(/\n<\/li>/);
      expect(output).toMatch(/\n<\/ul>/);
    });
  });

  describe('inline elements', () => {
    it('does not add newlines around inline elements', () => {
      const input = '<p>Hello <strong>world</strong></p>';
      const output = addLineBreaksForAI(input);
      // The inline element should stay on the same line as surrounding text
      expect(output).toContain('<strong>world</strong>');
      // But the block element should have newlines
      expect(output).toMatch(/<p>\n/);
    });

    it('preserves inline element content exactly', () => {
      const input = '<p>Text with <em>emphasis</em> and <code>code</code></p>';
      const output = addLineBreaksForAI(input);
      expect(output).toContain('<em>emphasis</em>');
      expect(output).toContain('<code>code</code>');
    });
  });

  describe('nested elements', () => {
    it('handles nested block elements', () => {
      const input = '<div><p>Nested</p></div>';
      const output = addLineBreaksForAI(input);
      const lines = output.split('\n');
      expect(lines.length).toBeGreaterThan(2);
    });

    it('handles deeply nested structures', () => {
      const input = '<div><ul><li>Item</li></ul></div>';
      const output = addLineBreaksForAI(input);
      expect(output).toMatch(/<div>\n/);
      expect(output).toMatch(/<ul>\n/);
      expect(output).toMatch(/<li>\n/);
    });
  });

  describe('edge cases', () => {
    it('returns empty string unchanged', () => {
      expect(addLineBreaksForAI('')).toBe('');
    });

    it('handles null gracefully', () => {
      expect(addLineBreaksForAI(null as unknown as string)).toBe(null);
    });

    it('handles undefined gracefully', () => {
      expect(addLineBreaksForAI(undefined as unknown as string)).toBe(undefined);
    });

    it('handles plain text without HTML', () => {
      const input = 'Just plain text';
      const output = addLineBreaksForAI(input);
      expect(output).toBe('Just plain text');
    });

    it('handles self-closing tags', () => {
      const input = '<p>Text<br/>More text</p>';
      const output = addLineBreaksForAI(input);
      expect(output).toContain('<br/>');
    });

    it('handles attributes on tags', () => {
      const input = '<p class="test" id="para">Text</p>';
      const output = addLineBreaksForAI(input);
      expect(output).toMatch(/<p class="test" id="para">\n/);
    });

    it('handles attributes containing > inside quoted values', () => {
      const input = '<p data-test="a > b">Text</p>';
      const output = addLineBreaksForAI(input);
      expect(output).toContain('<p data-test="a > b">\nText');
      expect(output).not.toContain('a >\n b');
    });
  });

  describe('idempotency', () => {
    it('does not add duplicate newlines when run multiple times', () => {
      const input = '<p>Text</p>';
      const firstPass = addLineBreaksForAI(input);
      const secondPass = addLineBreaksForAI(firstPass);
      expect(secondPass).toBe(firstPass);
    });

    it('handles already formatted content', () => {
      const input = '<p>\nAlready formatted\n</p>';
      const output = addLineBreaksForAI(input);
      // Should not add more newlines if they already exist
      expect(output).not.toMatch(/\n\n/);
    });
  });

  describe('real-world TipTap content', () => {
    it('formats typical TipTap output', () => {
      const input = '<h1>Document Title</h1><p>This is a paragraph with <strong>bold</strong> text.</p><ul><li>First item</li><li>Second item</li></ul>';
      const output = addLineBreaksForAI(input);
      const lines = output.split('\n');

      // Should have multiple lines
      expect(lines.length).toBeGreaterThan(5);

      // Should preserve all content
      expect(output).toContain('Document Title');
      expect(output).toContain('This is a paragraph');
      expect(output).toContain('<strong>bold</strong>');
      expect(output).toContain('First item');
      expect(output).toContain('Second item');
    });

    it('preserves trailing space in mid-thought content', () => {
      // This is the key user scenario - user stops typing mid-thought
      const input = '<p>I was thinking about </p>';
      const output = addLineBreaksForAI(input);
      expect(output).toContain('I was thinking about ');
    });
  });
});
