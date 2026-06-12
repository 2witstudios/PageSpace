import { describe, it, expect } from 'vitest';
import { findAndReplace, insertAtAnchor } from '../text-edit';
import { addLineBreaksForAI } from '../line-breaks';

describe('findAndReplace', () => {
  describe('search not found', () => {
    it('returns unchanged content with found: false when search is absent', () => {
      const result = findAndReplace({
        content: 'hello world',
        search: 'missing',
        replacement: 'x',
        isRawText: true,
      });

      expect(result.found).toBe(false);
      expect(result.matchCount).toBe(0);
      expect(result.newContent).toBe(result.oldContent);
    });

    it('treats null content as empty string', () => {
      const result = findAndReplace({
        content: null,
        search: 'anything',
        replacement: 'x',
        isRawText: true,
      });

      expect(result.found).toBe(false);
      expect(result.oldContent).toBe('');
      expect(result.newContent).toBe('');
    });
  });

  describe('throws on bad input', () => {
    it('throws when search is empty', () => {
      expect(() =>
        findAndReplace({ content: 'hello', search: '', replacement: 'x', isRawText: true })
      ).toThrow('Search string cannot be empty');
    });
  });

  describe('first-match replacement (replaceAll: false, the default)', () => {
    it('replaces only the first occurrence', () => {
      const result = findAndReplace({
        content: 'foo bar foo',
        search: 'foo',
        replacement: 'baz',
        isRawText: true,
      });

      expect(result.found).toBe(true);
      expect(result.matchCount).toBe(1);
      expect(result.newContent).toBe('baz bar foo');
    });

    it('returns matchCount of 1 even when multiple occurrences exist', () => {
      const result = findAndReplace({
        content: 'a a a',
        search: 'a',
        replacement: 'b',
        isRawText: true,
      });

      expect(result.matchCount).toBe(1);
    });
  });

  describe('replaceAll: true', () => {
    it('replaces every occurrence', () => {
      const result = findAndReplace({
        content: 'foo bar foo baz foo',
        search: 'foo',
        replacement: 'qux',
        replaceAll: true,
        isRawText: true,
      });

      expect(result.found).toBe(true);
      expect(result.matchCount).toBe(3);
      expect(result.newContent).toBe('qux bar qux baz qux');
    });

    it('replaces across lines', () => {
      const result = findAndReplace({
        content: 'foo\nfoo',
        search: 'foo',
        replacement: 'bar',
        replaceAll: true,
        isRawText: true,
      });

      expect(result.newContent).toBe('bar\nbar');
      expect(result.matchCount).toBe(2);
    });
  });

  describe('replacement that deletes the match (empty replacement)', () => {
    it('removes the matched text', () => {
      const result = findAndReplace({
        content: 'hello world',
        search: ' world',
        replacement: '',
        isRawText: true,
      });

      expect(result.found).toBe(true);
      expect(result.newContent).toBe('hello');
    });
  });

  describe('HTML normalization', () => {
    it('normalizes HTML before searching so agents can match readable text', () => {
      const htmlContent = '<p>Hello</p><p>World</p>';
      const normalized = addLineBreaksForAI(htmlContent);

      const result = findAndReplace({
        content: htmlContent,
        search: 'Hello',
        replacement: 'Hi',
        isRawText: false,
      });

      expect(result.oldContent).toBe(normalized);
      expect(result.found).toBe(true);
      expect(result.newContent).toContain('Hi');
      expect(result.newContent).not.toContain('Hello');
    });

    it('does not normalize raw text (markdown/code)', () => {
      const content = 'line one\nline two';

      const result = findAndReplace({
        content,
        search: 'line one',
        replacement: 'line ONE',
        isRawText: true,
      });

      expect(result.oldContent).toBe(content);
    });
  });
});

describe('insertAtAnchor', () => {
  describe('anchor not found', () => {
    it('returns unchanged content with inserted: false', () => {
      const result = insertAtAnchor({
        content: 'line one\nline two',
        anchor: 'missing',
        insertion: 'new line',
        position: 'after',
        isRawText: true,
      });

      expect(result.inserted).toBe(false);
      expect(result.anchorLine).toBeNull();
      expect(result.newContent).toBe(result.oldContent);
    });

    it('treats null content as empty string', () => {
      const result = insertAtAnchor({
        content: null,
        anchor: 'something',
        insertion: 'new',
        position: 'after',
        isRawText: true,
      });

      expect(result.inserted).toBe(false);
      expect(result.oldContent).toBe('');
    });
  });

  describe('throws on bad input', () => {
    it('throws when anchor is empty', () => {
      expect(() =>
        insertAtAnchor({ content: 'hello', anchor: '', insertion: 'x', position: 'after', isRawText: true })
      ).toThrow('Anchor string cannot be empty');
    });
  });

  describe('insert after', () => {
    it('inserts a new line immediately after the anchor line', () => {
      const result = insertAtAnchor({
        content: 'line one\nline two\nline three',
        anchor: 'line two',
        insertion: 'inserted line',
        position: 'after',
        isRawText: true,
      });

      expect(result.inserted).toBe(true);
      expect(result.anchorLine).toBe(2);
      expect(result.newContent).toBe('line one\nline two\ninserted line\nline three');
    });

    it('inserts after the last line without trailing newline issues', () => {
      const result = insertAtAnchor({
        content: 'line one\nline two',
        anchor: 'line two',
        insertion: 'appended',
        position: 'after',
        isRawText: true,
      });

      expect(result.newContent).toBe('line one\nline two\nappended');
    });

    it('inserts after the first line', () => {
      const result = insertAtAnchor({
        content: 'first\nsecond\nthird',
        anchor: 'first',
        insertion: 'inserted',
        position: 'after',
        isRawText: true,
      });

      expect(result.newContent).toBe('first\ninserted\nsecond\nthird');
      expect(result.anchorLine).toBe(1);
    });
  });

  describe('insert before', () => {
    it('inserts a new line immediately before the anchor line', () => {
      const result = insertAtAnchor({
        content: 'line one\nline two\nline three',
        anchor: 'line two',
        insertion: 'inserted line',
        position: 'before',
        isRawText: true,
      });

      expect(result.inserted).toBe(true);
      expect(result.anchorLine).toBe(2);
      expect(result.newContent).toBe('line one\ninserted line\nline two\nline three');
    });

    it('inserts before the first line', () => {
      const result = insertAtAnchor({
        content: 'first\nsecond',
        anchor: 'first',
        insertion: 'prepended',
        position: 'before',
        isRawText: true,
      });

      expect(result.newContent).toBe('prepended\nfirst\nsecond');
      expect(result.anchorLine).toBe(1);
    });
  });

  describe('anchor matching', () => {
    it('matches the first line containing the anchor substring', () => {
      const result = insertAtAnchor({
        content: 'prefix anchor suffix\nother anchor line',
        anchor: 'anchor',
        insertion: 'new',
        position: 'after',
        isRawText: true,
      });

      // First line matched; second is untouched
      expect(result.anchorLine).toBe(1);
      expect(result.newContent).toBe('prefix anchor suffix\nnew\nother anchor line');
    });
  });

  describe('HTML normalization', () => {
    it('normalizes HTML before inserting so agents can anchor to readable text', () => {
      const htmlContent = '<h2>Summary</h2><p>Details here</p>';
      const normalized = addLineBreaksForAI(htmlContent);
      const summaryLine = normalized.split('\n').find(l => l.includes('Summary'))!;
      expect(summaryLine).toBeTruthy();

      const result = insertAtAnchor({
        content: htmlContent,
        anchor: 'Summary',
        insertion: 'New paragraph',
        position: 'after',
        isRawText: false,
      });

      expect(result.inserted).toBe(true);
      expect(result.oldContent).toBe(normalized);
      expect(result.newContent).toContain('New paragraph');
    });
  });

  describe('HTML block boundary snapping', () => {
    it('inserts AFTER the closing </h2> tag, not inside it', () => {
      // Without boundary snapping the anchor "Summary" would match the text
      // line inside <h2>, and the insertion would land between "Summary" and
      // "</h2>", producing invalid markup.
      const htmlContent = '<h2>Summary</h2><p>Details</p>';

      const result = insertAtAnchor({
        content: htmlContent,
        anchor: 'Summary',
        insertion: 'New section',
        position: 'after',
        isRawText: false,
      });

      expect(result.inserted).toBe(true);
      const newLines = result.newContent.split('\n');
      const h2CloseIdx = newLines.findIndex(l => l.includes('</h2>'));
      const insertionIdx = newLines.findIndex(l => l === 'New section');
      // Insertion must be AFTER the </h2> closing tag
      expect(insertionIdx).toBeGreaterThan(h2CloseIdx);
    });

    it('inserts BEFORE the opening <h2> tag, not inside it', () => {
      const htmlContent = '<p>Before</p><h2>Summary</h2>';

      const result = insertAtAnchor({
        content: htmlContent,
        anchor: 'Summary',
        insertion: 'New section',
        position: 'before',
        isRawText: false,
      });

      expect(result.inserted).toBe(true);
      const newLines = result.newContent.split('\n');
      const h2OpenIdx = newLines.findIndex(l => l.includes('<h2>'));
      const insertionIdx = newLines.findIndex(l => l === 'New section');
      // Insertion must be BEFORE the <h2> opening tag
      expect(insertionIdx).toBeLessThan(h2OpenIdx);
    });

    it('advances past multiple closing tags for nested blocks', () => {
      // <blockquote><p>Quote text</p></blockquote>
      const htmlContent = '<blockquote><p>Quote text</p></blockquote>';

      const result = insertAtAnchor({
        content: htmlContent,
        anchor: 'Quote text',
        insertion: 'After blockquote',
        position: 'after',
        isRawText: false,
      });

      expect(result.inserted).toBe(true);
      // Insertion should be after the entire </blockquote>, not between </p> and </blockquote>
      const newLines = result.newContent.split('\n');
      const blockquoteCloseIdx = newLines.findIndex(l => l.includes('</blockquote>'));
      const insertionIdx = newLines.findIndex(l => l === 'After blockquote');
      expect(insertionIdx).toBeGreaterThan(blockquoteCloseIdx);
    });

    it('backs up past multiple opening tags for nested before-blocks', () => {
      // <blockquote><p>Quote text</p></blockquote>
      const htmlContent = '<blockquote><p>Quote text</p></blockquote>';

      const result = insertAtAnchor({
        content: htmlContent,
        anchor: 'Quote text',
        insertion: 'Before blockquote',
        position: 'before',
        isRawText: false,
      });

      expect(result.inserted).toBe(true);
      // Insertion should be before the entire <blockquote>, not between <blockquote> and <p>
      const newLines = result.newContent.split('\n');
      const blockquoteOpenIdx = newLines.findIndex(l => l.includes('<blockquote>'));
      const insertionIdx = newLines.findIndex(l => l === 'Before blockquote');
      expect(insertionIdx).toBeLessThan(blockquoteOpenIdx);
    });

    it('does not snap boundaries for raw text (markdown/code)', () => {
      // Raw text has no HTML tags — the current line-based behavior is correct
      const result = insertAtAnchor({
        content: 'line one\nline two\nline three',
        anchor: 'line two',
        insertion: 'inserted',
        position: 'after',
        isRawText: true,
      });

      // Standard after-line insertion, no HTML snapping
      expect(result.newContent).toBe('line one\nline two\ninserted\nline three');
    });
  });
});
