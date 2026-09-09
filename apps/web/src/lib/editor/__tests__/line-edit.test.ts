import { describe, it, expect } from 'vitest';
import {
  canonicalizeForLineEditing,
  deleteLines,
  insertLines,
  LineRangeError,
  projectLines,
  replaceLines,
} from '../line-edit';
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

describe('line accounting (#2463)', () => {
  // The reported tell: a 91-line replacement answered `newLineCount: 9`. The
  // replacement was pushed into the line array as ONE element, so the count was
  // (surrounding lines + 1) no matter how many lines the payload held.
  it('counts every line of a multi-line replacement', () => {
    const document = Array.from({ length: 89 }, (_, i) => `old ${i + 1}`).join('\n');
    const payload = Array.from({ length: 91 }, (_, i) => `new ${i + 1}`).join('\n');

    const result = replaceLines({
      content: document,
      startLine: 1,
      endLine: 89,
      replacement: payload,
      isRawText: true,
    });

    expect(result.newLineCount).toBe(91);
    expect(result.previousLineCount).toBe(89);
    expect(result.newContent).toBe(payload);
  });

  it('reports the count a subsequent read returns, for every mode', () => {
    const cases: Array<{ name: string; content: string; payload: string; isRawText: boolean }> = [
      { name: 'markdown', content: '# a\n\nb\nc', payload: '# x\n\ny\nz\nw', isRawText: true },
      { name: 'html', content: '<p>a</p><p>b</p>', payload: '<p>x</p><p>y</p><p>z</p>', isRawText: false },
      // The #2463 page: html contentMode, raw JSON content.
      { name: 'html-mode JSON', content: '{\n  "a": 1\n}', payload: '{\n  "a": 2,\n  "b": 3\n}', isRawText: false },
    ];

    for (const { name, content, payload, isRawText } of cases) {
      const before = projectLines(content, isRawText).length;
      const result = replaceLines({
        content,
        startLine: 1,
        endLine: before,
        replacement: payload,
        isRawText,
      });

      // What a read of the stored page would return, computed the way the read
      // path computes it — not from the same array the write used.
      const afterRead = projectLines(result.newContent, isRawText).length;
      expect(`${name}: ${result.newLineCount}`).toBe(`${name}: ${afterRead}`);
      expect(result.newContent).toBe(canonicalizeForLineEditing(result.newContent, isRawText));
    }
  });

  it('round-trips N lines through write -> read for html-mode content holding JSON', () => {
    const payload = Array.from({ length: 40 }, (_, i) => `  "key${i}": ${i},`).join('\n');
    const result = replaceLines({
      content: '{}',
      startLine: 1,
      endLine: 1,
      replacement: payload,
      isRawText: false,
    });

    expect(result.newLineCount).toBe(40);
    expect(projectLines(result.newContent, false)).toHaveLength(40);
    expect(result.newContent).toBe(payload);
  });

  it('leaves no stale tail when the range covers the whole document', () => {
    const document = 'a\nb\nc\nd\ne';
    const result = replaceLines({
      content: document,
      startLine: 1,
      endLine: 5,
      replacement: 'only',
      isRawText: true,
    });
    expect(result.newContent).toBe('only');
    expect(result.newLineCount).toBe(1);
  });

  it('stores the canonical projection for HTML, so the next read reshapes nothing', () => {
    const result = replaceLines({
      content: '<p>a</p>',
      startLine: 2,
      endLine: 2,
      replacement: '<p>inner</p>',
      isRawText: false,
    });

    // A payload with its own block tags is normalized ONCE, here, and the
    // reported count is measured after that pass.
    expect(result.newContent).toBe(canonicalizeForLineEditing(result.newContent, false));
    expect(result.newLineCount).toBe(result.newContent.split('\n').length);
  });
});

describe('expectedTotalLines staleness guard', () => {
  it('refuses an edit addressed against a stale line count', () => {
    // #2463 exactly: the agent believed 81 lines, the document had 89, and the
    // edit silently applied to the first 81 and left the last 8 behind.
    const document = Array.from({ length: 89 }, (_, i) => `line ${i + 1}`).join('\n');

    expect(() =>
      replaceLines({
        content: document,
        startLine: 1,
        endLine: 81,
        replacement: 'new',
        isRawText: true,
        expectedTotalLines: 81,
      })
    ).toThrow(/Document has 89 lines, but the edit was addressed against 81/);
  });

  it('classifies a staleness refusal separately from a bad range', () => {
    const stale = (() => {
      try {
        replaceLines({ content: 'a\nb\nc', startLine: 1, endLine: 1, replacement: 'x', isRawText: true, expectedTotalLines: 9 });
      } catch (error) { return error; }
    })();
    const range = (() => {
      try {
        replaceLines({ content: 'a\nb\nc', startLine: 1, endLine: 9, replacement: 'x', isRawText: true });
      } catch (error) { return error; }
    })();

    expect((stale as LineRangeError).kind).toBe('stale');
    expect((range as LineRangeError).kind).toBe('range');
  });

  it('allows the edit when the expected count matches', () => {
    const result = replaceLines({
      content: 'a\nb\nc',
      startLine: 2,
      endLine: 2,
      replacement: 'B',
      isRawText: true,
      expectedTotalLines: 3,
    });
    expect(result.newContent).toBe('a\nB\nc');
  });
});

describe('insertLines', () => {
  it('inserts every line of a multi-line payload and counts them', () => {
    const result = insertLines({ content: 'a\nb', startLine: 2, insertion: 'x\ny\nz', isRawText: true });
    expect(result.newContent).toBe('a\nx\ny\nz\nb');
    expect(result.newLineCount).toBe(5);
    expect(result.previousLineCount).toBe(2);
    expect(result.changeType).toBe('insertion');
  });

  it('clamps an insert past the end to the end', () => {
    const result = insertLines({ content: 'a\nb', startLine: 99, insertion: 'c', isRawText: true });
    expect(result.newContent).toBe('a\nb\nc');
  });

  it('rejects a line number below 1', () => {
    expect(() => insertLines({ content: 'a', startLine: 0, insertion: 'x', isRawText: true })).toThrow(LineRangeError);
  });

  it('honours the staleness guard', () => {
    expect(() =>
      insertLines({ content: 'a\nb', startLine: 1, insertion: 'x', isRawText: true, expectedTotalLines: 7 })
    ).toThrow(/addressed against 7/);
  });
});

describe('deleteLines', () => {
  it('deletes a range and reports the resulting count', () => {
    const result = deleteLines({ content: 'a\nb\nc\nd', startLine: 2, endLine: 3, isRawText: true });
    expect(result.newContent).toBe('a\nd');
    expect(result.newLineCount).toBe(2);
    expect(result.linesReplaced).toBe(2);
    expect(result.changeType).toBe('deletion');
  });

  it('rejects an out-of-range delete', () => {
    expect(() => deleteLines({ content: 'a\nb', startLine: 1, endLine: 5, isRawText: true })).toThrow(/Document has 2 lines/);
  });

  it('honours the staleness guard', () => {
    expect(() =>
      deleteLines({ content: 'a\nb', startLine: 1, endLine: 1, isRawText: true, expectedTotalLines: 5 })
    ).toThrow(/addressed against 5/);
  });
});
