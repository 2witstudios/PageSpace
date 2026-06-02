import { describe, it, expect } from 'vitest';
import { renderPublishedPage } from '../render-published';

describe('renderPublishedPage', () => {
  it('given any input, should return a full HTML document', () => {
    const out = renderPublishedPage({ html: '<p>hello</p>' });
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<html>');
    expect(out).toContain('</html>');
    expect(out).toContain('<body>');
  });

  it('given an author <script>, should PRESERVE it (published policy)', () => {
    const out = renderPublishedPage({
      html: '<div id="app"></div><script>document.getElementById("app").textContent = "hi";</script>',
    });
    expect(out).toContain('<script>');
    expect(out).toContain('document.getElementById("app")');
  });

  it('given an external url() inside an author <style>, should sanitize it', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://evil.com/pixel.png"); }</style><p>x</p>',
    });
    expect(out).not.toContain('https://evil.com');
    expect(out).toContain('url("")');
  });

  it('given a data:image url() inside an author <style>, should preserve it', () => {
    const out = renderPublishedPage({
      html: '<style>.x { background: url("data:image/png;base64,iVBORw0KGgo="); }</style>',
    });
    expect(out).toContain('data:image/png;base64,iVBORw0KGgo=');
  });

  it('should embed the baseline CSP <meta>', () => {
    const out = renderPublishedPage({ html: '<p>x</p>' });
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    expect(out).toContain("default-src 'none'");
    expect(out).toContain("script-src 'unsafe-inline'");
  });

  it('should embed NO cookie, session, token, or API URL strings', () => {
    const out = renderPublishedPage({
      html: '<p>x</p>',
      title: 'My Page',
    });
    const lower = out.toLowerCase();
    expect(lower).not.toContain('cookie');
    expect(lower).not.toContain('session');
    expect(lower).not.toContain('token');
    expect(lower).not.toContain('authorization');
  });

  it('given a title with HTML, should escape it', () => {
    const out = renderPublishedPage({
      html: '<p>x</p>',
      title: '<script>alert(1)</script>',
    });
    expect(out).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(out).not.toContain('<title><script>');
  });

  it('given no title, should default to Untitled', () => {
    const out = renderPublishedPage({ html: '<p>x</p>' });
    expect(out).toContain('<title>Untitled</title>');
  });
});
