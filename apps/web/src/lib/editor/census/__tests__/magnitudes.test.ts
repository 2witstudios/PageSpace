import { describe, it, expect, afterAll } from 'vitest';
import { createDomWorkspace } from '../constructs';
import { emptyMagnitudes, htmlMagnitudes, lineCount, MAGNITUDE_METRICS } from '../magnitudes';
import { analyzeMarkdown } from '../markdown';

const workspace = createDomWorkspace();
afterAll(() => workspace.close());

const measure = (html: string) => htmlMagnitudes(workspace.parse(html));

describe('htmlMagnitudes', () => {
  it('counts the images in a document', () => {
    expect(measure('<p>a</p><img src="a.png"><img src="b.png">').images).toBe(2);
  });

  it('reports the tallest table, not the last one', () => {
    const html =
      '<table><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></table>' +
      '<table><tr><td>1</td></tr></table>';
    expect(measure(html).tableRows).toBe(3);
  });

  it('reports the widest row as the column count', () => {
    // A table whose header is narrower than a body row still has to fit the
    // body row on the page.
    const html = '<table><tr><th>a</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>';
    expect(measure(html).tableColumns).toBe(3);
  });

  it('counts the lines in a code block, which the paginator cannot split', () => {
    expect(measure('<pre><code>one\ntwo\nthree</code></pre>').codeBlockLines).toBe(3);
  });

  it('measures the longest block, and reports its length rather than its text', () => {
    const result = measure('<p>short</p><p>a much longer paragraph than the first one</p>');
    expect(result.blockCharacters).toBe('a much longer paragraph than the first one'.length);
    expect(JSON.stringify(result)).not.toContain('longer');
  });

  it('measures a list item as everything it holds, which is how it is laid out', () => {
    const result = measure('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
    expect(result.blockCharacters).toBe('outerinner'.length);
  });

  it('is all zeroes for a document with no block in it at all', () => {
    expect(measure('')).toEqual(emptyMagnitudes());
  });
});

describe('markdown magnitudes', () => {
  it('counts the header as a row, because the page has to fit it', () => {
    const markdown = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n';
    expect(analyzeMarkdown(markdown, workspace).magnitudes).toMatchObject({ tableRows: 3, tableColumns: 2 });
  });

  it('counts the lines in a fenced block', () => {
    expect(analyzeMarkdown('```ts\none\ntwo\n```\n', workspace).magnitudes.codeBlockLines).toBe(2);
  });

  it('counts images, including one inside a table cell', () => {
    const markdown = '![a](a.png)\n\n| x |\n| --- |\n| ![b](b.png) |\n';
    expect(analyzeMarkdown(markdown, workspace).magnitudes.images).toBe(2);
  });

  it('measures the longest block without reporting it', () => {
    const result = analyzeMarkdown('short\n\na considerably longer paragraph of prose\n', workspace);
    expect(result.magnitudes.blockCharacters).toBeGreaterThan('short'.length);
    expect(JSON.stringify(result.magnitudes)).not.toContain('prose');
  });
});

describe('lineCount', () => {
  it('counts a block with no newline in it as one line, not none', () => {
    expect(lineCount('one')).toBe(1);
    expect(lineCount('')).toBe(1);
  });

  it('counts a trailing newline as the line it opens', () => {
    expect(lineCount('one\n')).toBe(2);
  });
});

describe('MAGNITUDE_METRICS', () => {
  it('names every field the measurements produce, so the report cannot go stale', () => {
    expect(MAGNITUDE_METRICS.map((metric) => metric.key).sort()).toEqual(
      Object.keys(emptyMagnitudes()).sort(),
    );
  });
});
