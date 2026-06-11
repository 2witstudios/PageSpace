import { describe, it, expect } from 'vitest';
import { serializePageContentForAI, isTextSerializablePageType } from '../page-serializer';

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
