import { describe, it, expect } from 'vitest';
import { analyzeMarkdown, markdownConstructs } from '../markdown';

describe('markdownConstructs', () => {
  it('finds an image, which the schema has no node for', () => {
    expect(markdownConstructs('text\n\n![alt](https://example.test/a.png)\n')).toContain('md:image');
  });

  it('finds a task list, which the schema has no node for', () => {
    expect(markdownConstructs('- [ ] todo\n- [x] done\n')).toContain('md:task-list');
  });

  it('finds headings below level 3', () => {
    expect(markdownConstructs('# a\n#### b\n')).toContain('md:heading-4-6');
  });

  it('does not report a level 1-3 heading', () => {
    expect(markdownConstructs('### a\n')).toEqual([]);
  });

  it('finds raw HTML', () => {
    expect(markdownConstructs('<figure><img src="a.png"></figure>\n')).toContain('md:raw-html');
  });

  it('finds constructs inside a table cell, which hangs off no token list', () => {
    expect(markdownConstructs('| a | b |\n| --- | --- |\n| ![alt](a.png) | x |\n')).toContain('md:image');
  });

  it('finds highlight and footnote syntax', () => {
    expect(markdownConstructs('==a==\n\n[^1]: c\n')).toEqual(
      expect.arrayContaining(['md:highlight', 'md:footnote']),
    );
  });

  it('does not call strikethrough a gap, because the schema has the mark', () => {
    // It was counted as one, and put 17 documents in a table headed "syntax the
    // schema has no node for". StarterKit ships `strike`; round-trip.test.ts
    // holds the schema to it.
    expect(markdownConstructs('~~struck~~\n')).toEqual([]);
  });

  it('ignores syntax inside a fenced code block, which is literal text', () => {
    expect(markdownConstructs('```md\n![alt](a.png)\n- [ ] todo\n```\n')).toEqual([]);
  });

  it('ignores syntax inside an indented code block and a backtick span', () => {
    expect(markdownConstructs('    ![alt](a.png)\n\nInline `![alt](b.png)` here.\n')).toEqual([]);
  });

  it('returns a sorted list, so the report is stable between runs', () => {
    expect(markdownConstructs('#### a\n\n![b](c.png)\n')).toEqual(['md:heading-4-6', 'md:image']);
  });

  it('returns nothing for prose the schema can hold', () => {
    expect(markdownConstructs('# Title\n\nSome **bold** text.\n')).toEqual([]);
  });
});

describe('analyzeMarkdown images', () => {
  it('classifies where each image points, in one pass with the constructs', () => {
    const result = analyzeMarkdown('![a](https://cdn.example.test/a.png)\n\n![b](/api/files/xyz/view)\n');
    expect(result.constructs).toContain('md:image');
    expect(result.images).toEqual([
      { bucket: 'img-src:external-https', host: 'cdn.example.test' },
      { bucket: 'img-src:pagespace-file', host: null },
    ]);
  });

  it('finds the image in a table cell, which hangs off no token list', () => {
    const result = analyzeMarkdown('| a |\n| --- |\n| ![x](data:image/png;base64,y) |\n');
    expect(result.images).toEqual([{ bucket: 'img-src:data-uri', host: null }]);
  });

  it('does not treat an image inside a code fence as an image', () => {
    const result = analyzeMarkdown('```md\n![a](a.png)\n```\n');
    expect(result.images).toEqual([]);
    expect(result.constructs).toEqual([]);
  });

  it('reports no image and no construct for prose', () => {
    expect(analyzeMarkdown('just words\n')).toMatchObject({ constructs: [], images: [] });
  });
});
