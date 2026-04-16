import { describe, it, expect } from 'vitest';
import { remapDocumentSelectors } from '../remap-document-selectors';

describe('remapDocumentSelectors', () => {
  it('remaps body selector to .canvas-root', () => {
    expect(remapDocumentSelectors('body { background: #000; }'))
      .toBe('.canvas-root { background: #000; }');
  });

  it('remaps html selector to .canvas-root', () => {
    expect(remapDocumentSelectors('html { margin: 0; }'))
      .toBe('.canvas-root { margin: 0; }');
  });

  it('remaps :root selector to .canvas-root', () => {
    expect(remapDocumentSelectors(':root { --bg: #000; }'))
      .toBe('.canvas-root { --bg: #000; }');
  });

  it('remaps body with descendant selector', () => {
    expect(remapDocumentSelectors('body * { color: #fff; }'))
      .toBe('.canvas-root * { color: #fff; }');
  });

  it('remaps body with class descendant', () => {
    expect(remapDocumentSelectors('body .wrap { padding: 10px; }'))
      .toBe('.canvas-root .wrap { padding: 10px; }');
  });

  it('remaps body in comma-separated selectors', () => {
    expect(remapDocumentSelectors('body, .foo { margin: 0; }'))
      .toBe('.canvas-root, .foo { margin: 0; }');
  });

  it('remaps body with child combinator', () => {
    expect(remapDocumentSelectors('body > div { display: flex; }'))
      .toBe('.canvas-root > div { display: flex; }');
  });

  it('does not match partial words like .somebody', () => {
    const input = '.somebody { color: red; }';
    expect(remapDocumentSelectors(input)).toBe(input);
  });

  it('does not match partial words like .html-content', () => {
    const input = '.html-content { color: red; }';
    expect(remapDocumentSelectors(input)).toBe(input);
  });

  it('remaps multiple document selectors in one stylesheet', () => {
    const input = `
:root { --bg: #000; --fg: #fff; }
html { margin: 0; min-height: 100%; }
body { background: var(--bg); color: var(--fg); }
body * { color: inherit; }
.card { border: 1px solid #333; }`;

    const result = remapDocumentSelectors(input);
    expect(result).toContain('.canvas-root { --bg: #000;');
    expect(result).toContain('.canvas-root { margin: 0;');
    expect(result).toContain('.canvas-root { background: var(--bg);');
    expect(result).toContain('.canvas-root * { color: inherit;');
    expect(result).toContain('.card { border: 1px solid #333; }');
  });

  it('handles body with pseudo-selectors', () => {
    expect(remapDocumentSelectors('body::before { content: ""; }'))
      .toBe('.canvas-root::before { content: ""; }');
  });

  it('returns empty string for empty input', () => {
    expect(remapDocumentSelectors('')).toBe('');
  });

  it('leaves class-only selectors untouched', () => {
    const input = '.wrap { max-width: 1440px; }';
    expect(remapDocumentSelectors(input)).toBe(input);
  });

  it('handles selector after closing brace', () => {
    const input = '.foo { color: red; }\nbody { color: white; }';
    const result = remapDocumentSelectors(input);
    expect(result).toContain('.canvas-root { color: white; }');
    expect(result).toContain('.foo { color: red; }');
  });

  it('remaps body with attribute selector', () => {
    expect(remapDocumentSelectors('body[data-theme="dark"] { background: #000; }'))
      .toBe('.canvas-root[data-theme="dark"] { background: #000; }');
  });

  it('remaps body inside @media block', () => {
    const input = '@media (max-width: 768px) {\n  body { padding: 16px; }\n}';
    const result = remapDocumentSelectors(input);
    expect(result).toContain('.canvas-root { padding: 16px; }');
  });
});
