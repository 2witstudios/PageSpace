import { describe, it, expect, afterAll } from 'vitest';
import { classifyDocumentContent, createDomWorkspace } from '../document-content-format';

const workspace = createDomWorkspace();
afterAll(() => workspace.close());

const classify = (content: string) => classifyDocumentContent(content, workspace);

describe('classifyDocumentContent', () => {
  it('classifies whitespace-only content as empty', () => {
    expect(classify('')).toEqual({ format: 'empty', confident: true });
    expect(classify('   \n\t')).toEqual({ format: 'empty', confident: true });
  });

  it('classifies real HTML markup as html', () => {
    expect(classify('<p>hello <strong>world</strong></p>')).toEqual({ format: 'html', confident: true });
  });

  it('classifies markdown source with no HTML tags as markdown-source', () => {
    const markdown = '# Heading\n\nSome *emphasis* and a [link](https://example.com).\n\n- one\n- two';
    expect(classify(markdown)).toEqual({ format: 'markdown-source', confident: true });
  });

  it('does not mistake an unescaped generic for HTML', () => {
    // The exact trap the mislabelled population fell into: prose containing
    // ActionResult<void> parses to a phantom, non-real "element" under a naive
    // DOM scan. It must still classify as markdown-source, not html.
    expect(classify('# Notes\n\nReturns `ActionResult<void>` from the handler.')).toEqual({
      format: 'markdown-source',
      confident: true,
    });
  });

  it('does not misclassify markdown ending in a stray angle bracket as html', () => {
    // This is exactly the boundary heuristic `detectPageContentFormat` uses
    // (startsWith('<') && endsWith('>')) failing: content that merely ends
    // with '>' is not HTML.
    const markdown = '# Title\n\nSome text that happens to end with a caret >';
    expect(classify(markdown)).toEqual({ format: 'markdown-source', confident: true });
  });

  it('classifies markdown embedding real raw HTML as html, since it does contain a real element', () => {
    expect(classify('# Title\n\n<div>raw html block</div>')).toEqual({ format: 'html', confident: true });
  });

  it('reports low confidence rather than guessing when parsing throws', () => {
    const throwingWorkspace = {
      parse(): never {
        throw new TypeError('boom');
      },
      close() {},
    };
    expect(classifyDocumentContent('# unparseable', throwingWorkspace as never)).toEqual({
      format: 'unknown',
      confident: false,
      reason: 'TypeError',
    });
  });
});
