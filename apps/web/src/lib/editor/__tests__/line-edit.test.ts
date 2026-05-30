import { describe, it, expect } from 'vitest';
import { replaceLines } from '../line-edit';
import { addLineBreaksForAI } from '../line-breaks';

describe('replaceLines', () => {
  describe('diff baseline consistency (the bug)', () => {
    it('returns oldContent formatted the same way as newContent for HTML', () => {
      // Raw stored HTML has no line breaks; both sides of the diff must be
      // normalized identically, otherwise a one-line edit looks like a full
      // document replacement.
      const content = '<p>Hello</p><p>World</p>';

      const result = replaceLines({
        content,
        startLine: 2,
        endLine: 2,
        replacement: 'Goodbye',
        isRawText: false,
      });

      expect(result.oldContent).toBe(addLineBreaksForAI(content));
    });

    it('produces a single-line diff for a single-line edit', () => {
      const content = '<p>Hello</p><p>World</p>';

      const result = replaceLines({
        content,
        startLine: 2,
        endLine: 2,
        replacement: 'Goodbye',
        isRawText: false,
      });

      const oldLines = result.oldContent.split('\n');
      const newLines = result.newContent.split('\n');

      expect(oldLines.length).toBe(newLines.length);
      const changed = oldLines.filter((line, i) => line !== newLines[i]);
      expect(changed).toEqual(['Hello']);
      expect(newLines[1]).toBe('Goodbye');
    });
  });

  describe('raw text (markdown / code)', () => {
    it('does not reformat raw text content', () => {
      const content = 'line one\nline two\nline three';

      const result = replaceLines({
        content,
        startLine: 2,
        endLine: 2,
        replacement: 'replaced',
        isRawText: true,
      });

      expect(result.oldContent).toBe(content);
      expect(result.newContent).toBe('line one\nreplaced\nline three');
    });
  });

  describe('replacement', () => {
    it('replaces a multi-line range with a single line', () => {
      const content = 'a\nb\nc\nd';

      const result = replaceLines({
        content,
        startLine: 2,
        endLine: 3,
        replacement: 'X',
        isRawText: true,
      });

      expect(result.newContent).toBe('a\nX\nd');
      expect(result.linesReplaced).toBe(2);
      expect(result.newLineCount).toBe(3);
      expect(result.changeType).toBe('replacement');
    });
  });

  describe('deletion', () => {
    it('removes lines when replacement is empty', () => {
      const content = 'a\nb\nc';

      const result = replaceLines({
        content,
        startLine: 2,
        endLine: 2,
        replacement: '',
        isRawText: true,
      });

      expect(result.newContent).toBe('a\nc');
      expect(result.newLineCount).toBe(2);
      expect(result.changeType).toBe('deletion');
    });
  });

  describe('validation', () => {
    it('throws on a start line below 1', () => {
      expect(() =>
        replaceLines({ content: 'a\nb', startLine: 0, endLine: 1, replacement: 'x', isRawText: true })
      ).toThrow(/Invalid line range/);
    });

    it('throws when endLine exceeds the document length', () => {
      expect(() =>
        replaceLines({ content: 'a\nb', startLine: 1, endLine: 5, replacement: 'x', isRawText: true })
      ).toThrow(/Document has 2 lines/);
    });

    it('throws when endLine is before startLine', () => {
      expect(() =>
        replaceLines({ content: 'a\nb\nc', startLine: 3, endLine: 2, replacement: 'x', isRawText: true })
      ).toThrow(/Invalid line range/);
    });
  });

  describe('null-safety', () => {
    it('treats null content as empty', () => {
      const result = replaceLines({
        content: null,
        startLine: 1,
        endLine: 1,
        replacement: 'first',
        isRawText: true,
      });

      expect(result.oldContent).toBe('');
      expect(result.newContent).toBe('first');
    });
  });
});
