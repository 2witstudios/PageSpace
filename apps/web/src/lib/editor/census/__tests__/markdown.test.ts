import { describe, it, expect, afterAll } from 'vitest';
import { analyzeMarkdown, markdownConstructs } from '../markdown';
import { createDomWorkspace } from '../constructs';

const workspace = createDomWorkspace();
afterAll(() => workspace.close());

const constructsOf = (markdown: string) => markdownConstructs(markdown, workspace);
const analyse = (markdown: string) => analyzeMarkdown(markdown, workspace);

describe('markdownConstructs', () => {
  it('finds an image, which the schema has no node for', () => {
    expect(constructsOf('text\n\n![alt](https://example.test/a.png)\n')).toContain('md:image');
  });

  it('finds a task list, which the schema has no node for', () => {
    expect(constructsOf('- [ ] todo\n- [x] done\n')).toContain('md:task-list');
  });

  it('finds headings below level 3', () => {
    expect(constructsOf('# a\n#### b\n')).toContain('md:heading-4-6');
  });

  it('does not report a level 1-3 heading', () => {
    expect(constructsOf('### a\n')).toEqual([]);
  });

  it('finds raw HTML', () => {
    expect(constructsOf('<figure><img src="a.png"></figure>\n')).toContain('md:raw-html');
  });

  it('finds constructs inside a table cell, which hangs off no token list', () => {
    expect(constructsOf('| a | b |\n| --- | --- |\n| ![alt](a.png) | x |\n')).toContain('md:image');
  });

  it('finds highlight and footnote syntax', () => {
    expect(constructsOf('==a==\n\n[^1]: c\n')).toEqual(
      expect.arrayContaining(['md:highlight', 'md:footnote']),
    );
  });

  it('does not call strikethrough a gap, because the schema has the mark', () => {
    // It was counted as one, and put 17 documents in a table headed "syntax the
    // schema has no node for". StarterKit ships `strike`; round-trip.test.ts
    // holds the schema to it.
    expect(constructsOf('~~struck~~\n')).toEqual([]);
  });

  it('ignores syntax inside a fenced code block, which is literal text', () => {
    expect(constructsOf('```md\n![alt](a.png)\n- [ ] todo\n```\n')).toEqual([]);
  });

  it('ignores syntax inside an indented code block and a backtick span', () => {
    expect(constructsOf('    ![alt](a.png)\n\nInline `![alt](b.png)` here.\n')).toEqual([]);
  });

  it('returns a sorted list, so the report is stable between runs', () => {
    expect(constructsOf('#### a\n\n![b](c.png)\n')).toEqual(['md:heading-4-6', 'md:image']);
  });

  it('returns nothing for prose the schema can hold', () => {
    expect(constructsOf('# Title\n\nSome **bold** text.\n')).toEqual([]);
  });
});

describe('analyzeMarkdown images', () => {
  it('classifies where each image points, in one pass with the constructs', () => {
    const result = analyse('![a](https://cdn.example.test/a.png)\n\n![b](/api/files/xyz/view)\n');
    expect(result.constructs).toContain('md:image');
    expect(result.images).toEqual([
      { bucket: 'img-src:external-https', host: 'cdn.example.test' },
      { bucket: 'img-src:pagespace-file', host: null },
    ]);
  });

  it('finds the image in a table cell, which hangs off no token list', () => {
    const result = analyse('| a |\n| --- |\n| ![x](data:image/png;base64,y) |\n');
    expect(result.images).toEqual([{ bucket: 'img-src:data-uri', host: null }]);
  });

  it('does not treat an image inside a code fence as an image', () => {
    const result = analyse('```md\n![a](a.png)\n```\n');
    expect(result.images).toEqual([]);
    expect(result.constructs).toEqual([]);
  });

  it('reports no image and no construct for prose', () => {
    expect(analyse('just words\n')).toMatchObject({ constructs: [], images: [] });
  });
});

describe('raw HTML embedded in markdown', () => {
  // `marked` emits one opaque `html` token and never looks inside it, so every
  // measurement below was reading zero until the census parsed it as HTML.
  it('finds an image written as a tag rather than as markdown syntax', () => {
    const result = analyse('text\n\n<img src="https://cdn.example.test/a.png">\n');
    expect(result.constructs).toContain('md:raw-html');
    expect(result.images).toEqual([
      { bucket: 'img-src:external-https', host: 'cdn.example.test' },
    ]);
    expect(result.magnitudes.images).toBe(1);
  });

  it('finds a data URI hidden in raw HTML, which is the one that must never be seeded', () => {
    const result = analyse('<img src="data:image/png;base64,iVBORw0KGgo=">\n');
    expect(result.images).toEqual([{ bucket: 'img-src:data-uri', host: null }]);
  });

  it('measures a table written as raw HTML', () => {
    const result = analyse('<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>\n');
    expect(result.magnitudes).toMatchObject({ tableRows: 2, tableColumns: 2 });
  });

  it('measures a code block written as raw HTML', () => {
    expect(analyse('<pre><code>a\nb\nc</code></pre>\n').magnitudes.codeBlockLines).toBe(3);
  });

  it('adds raw-HTML images to the markdown ones rather than replacing them', () => {
    const result = analyse('![a](a.png)\n\n<img src="b.png">\n');
    expect(result.magnitudes.images).toBe(2);
    expect(result.images).toHaveLength(2);
  });
});

describe('markdown table cells', () => {
  it('measures a cell as a block, the way the HTML half measures td', () => {
    // A table-only document reported no block at all, so the two populations
    // were being measured by different rules.
    const markdown = '| a | b |\n| --- | --- |\n| short | a considerably longer cell |\n';
    expect(analyse(markdown).magnitudes.blockCharacters).toBe('a considerably longer cell'.length);
  });
});
