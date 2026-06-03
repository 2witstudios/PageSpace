import { describe, it, expect } from 'vitest';
import { renderCanvasDocument, escapeHtml, BASELINE_CSP } from '../render-document';

describe('renderCanvasDocument', () => {
  it('given any input, should return a full HTML document', () => {
    const out = renderCanvasDocument({ html: '<p>hello</p>' });
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<html>');
    expect(out).toContain('</html>');
    expect(out).toContain('<body>');
    expect(out).toContain('<p>hello</p>');
  });

  it('given an author <script>, should PRESERVE it (isolation by origin, not sanitizer)', () => {
    const out = renderCanvasDocument({
      html: '<div id="app"></div><script>document.getElementById("app").textContent = "hi";</script>',
    });
    expect(out).toContain('<script>');
    expect(out).toContain('document.getElementById("app")');
  });

  it('given an external url() inside an author <style>, should sanitize it and not emit a <style> in the body', () => {
    const out = renderCanvasDocument({
      html: '<style>body { background: url("https://evil.com/pixel.png"); }</style><p>x</p>',
    });
    expect(out).not.toContain('https://evil.com');
    expect(out).toContain('url("")');
    // The author <style> is hoisted into <head> (sanitized), not duplicated in the body.
    expect(out).toContain('</head><body><p>x</p></body>');
  });

  it('given a data:image url() inside an author <style>, should preserve it', () => {
    const out = renderCanvasDocument({
      html: '<style>.x { background: url("data:image/png;base64,iVBORw0KGgo="); }</style>',
    });
    expect(out).toContain('data:image/png;base64,iVBORw0KGgo=');
  });

  it('should embed the baseline CSP <meta> WITHOUT a sandbox directive', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>' });
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    expect(out).toContain("default-src 'none'");
    expect(out).toContain("script-src 'unsafe-inline'");
    expect(BASELINE_CSP).not.toContain('sandbox');
  });

  it('should embed NO cookie, session, token, or API URL strings', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', title: 'My Page' }).toLowerCase();
    expect(out).not.toContain('cookie');
    expect(out).not.toContain('session');
    expect(out).not.toContain('token');
    expect(out).not.toContain('authorization');
  });

  it('given a title with HTML, should escape it', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', title: '<script>alert(1)</script>' });
    expect(out).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(out).not.toContain('<title><script>');
  });

  it('given no title, should default to Untitled', () => {
    expect(renderCanvasDocument({ html: '<p>x</p>' })).toContain('<title>Untitled</title>');
  });

  it('escapeHtml escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
