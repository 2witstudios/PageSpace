import { describe, it, expect } from 'vitest';
import {
  describeContentModeMismatch,
  isRawTextPage,
  isTextSerializablePageType,
  serializePageContentForAI,
} from '../page-serializer';

describe('serializePageContentForAI', () => {
  it('passes markdown-mode content through untouched', () => {
    const content = '# Title\n\n- item one\n- item two';
    expect(
      serializePageContentForAI({ type: 'DOCUMENT', contentMode: 'markdown', content })
    ).toBe(content);
  });

  it('passes CODE page content through untouched (raw HTML/XML must not be mangled)', () => {
    const content = '<div>\n  <span>raw</span>\n</div>';
    expect(
      serializePageContentForAI({ type: 'CODE', contentMode: null, content })
    ).toBe(content);
  });

  it('adds AI line breaks to HTML documents', () => {
    const html = '<p>one</p><p>two</p>';
    const result = serializePageContentForAI({ type: 'DOCUMENT', contentMode: 'html', content: html });
    expect(result).toContain('one');
    expect(result).toContain('two');
    expect(result.split('\n').length).toBeGreaterThan(1);
  });

  it('serializes empty/null content to an empty string', () => {
    expect(serializePageContentForAI({ type: 'DOCUMENT', contentMode: null, content: null })).toBe('');
  });
});

describe('isTextSerializablePageType', () => {
  it('accepts document-like pages', () => {
    expect(isTextSerializablePageType('DOCUMENT')).toBe(true);
    expect(isTextSerializablePageType('CODE')).toBe(true);
  });

  it('rejects page types whose read path is structured, not text', () => {
    expect(isTextSerializablePageType('CHANNEL')).toBe(false);
    expect(isTextSerializablePageType('TASK_LIST')).toBe(false);
    expect(isTextSerializablePageType('FILE')).toBe(false);
  });
});

describe('isRawTextPage', () => {
  it('is true for markdown documents and CODE pages', () => {
    expect(isRawTextPage({ type: 'DOCUMENT', contentMode: 'markdown' })).toBe(true);
    expect(isRawTextPage({ type: 'CODE', contentMode: 'html' })).toBe(true);
  });

  it('is false for html documents', () => {
    expect(isRawTextPage({ type: 'DOCUMENT', contentMode: 'html' })).toBe(false);
  });
});

describe('describeContentModeMismatch (#2463)', () => {
  it('warns for an html-mode document holding raw JSON', () => {
    const warning = describeContentModeMismatch({
      type: 'DOCUMENT',
      contentMode: 'html',
      content: '{\n  "leads": []\n}',
    });
    expect(warning).toMatch(/html contentMode/);
    expect(warning).toMatch(/markdown/);
  });

  it('warns for an html-mode document holding markdown', () => {
    expect(
      describeContentModeMismatch({ type: 'DOCUMENT', contentMode: 'html', content: '# Report\n\n- one' })
    ).toBeDefined();
  });

  it('does not name an endpoint an MCP principal cannot call', () => {
    const warning = describeContentModeMismatch({
      type: 'DOCUMENT',
      contentMode: 'html',
      content: 'plain text',
    });
    // convert-content-mode is session-auth only; pointing an agent at it would
    // just hand it a 401.
    expect(warning).not.toMatch(/convert-content-mode/);
  });

  it('stays quiet for a real HTML document', () => {
    expect(
      describeContentModeMismatch({ type: 'DOCUMENT', contentMode: 'html', content: '<p>hello</p>' })
    ).toBeUndefined();
  });

  it('stays quiet for a <br>-laid-out document — that content IS an HTML document', () => {
    expect(
      describeContentModeMismatch({ type: 'DOCUMENT', contentMode: 'html', content: '<p>a<br>b<br>c</p>' })
    ).toBeUndefined();
  });

  it('warns for JSON that happens to carry scraped markup', () => {
    // The dangerous case: a "contains a tag anywhere" test stays silent here
    // AND lets the normalizer rewrite the JSON. Both hang off one predicate.
    expect(
      describeContentModeMismatch({
        type: 'DOCUMENT',
        contentMode: 'html',
        content: '{"leads":[{"note":"call<br>then email"}]}',
      })
    ).toMatch(/html contentMode/);
  });

  it('stays quiet for markdown mode, CODE, empty content and non-documents', () => {
    expect(describeContentModeMismatch({ type: 'DOCUMENT', contentMode: 'markdown', content: '# x' })).toBeUndefined();
    expect(describeContentModeMismatch({ type: 'CODE', contentMode: 'html', content: 'const a = 1;' })).toBeUndefined();
    expect(describeContentModeMismatch({ type: 'DOCUMENT', contentMode: 'html', content: '   ' })).toBeUndefined();
    expect(describeContentModeMismatch({ type: 'DOCUMENT', contentMode: 'html', content: null })).toBeUndefined();
    // A SHEET serializes from its rows and a FILE from extracted text; neither
    // is HTML and neither is line-editable, so a mode warning would be noise.
    expect(describeContentModeMismatch({ type: 'SHEET', contentMode: 'html', content: 'A1,B1' })).toBeUndefined();
    expect(describeContentModeMismatch({ type: 'FILE', contentMode: 'html', content: 'extracted text' })).toBeUndefined();
  });
});
