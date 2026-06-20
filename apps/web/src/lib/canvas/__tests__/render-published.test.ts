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

describe('renderPublishedPage — assetBaseUrl', () => {
  it('given assetBaseUrl, should allow that host in CSS url() values', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://pagespace-published.t3.tigrisfiles.io/assets/abc123"); }</style>',
      assetBaseUrl: 'https://pagespace-published.t3.tigrisfiles.io',
    });
    expect(out).toContain('https://pagespace-published.t3.tigrisfiles.io/assets/abc123');
    expect(out).not.toContain('url("")');
  });

  it('given assetBaseUrl, should still block other HTTPS hosts in CSS url()', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://evil.com/tracker.gif"); }</style>',
      assetBaseUrl: 'https://pagespace-published.t3.tigrisfiles.io',
    });
    expect(out).not.toContain('evil.com');
    expect(out).toContain('url("")');
  });

  it('given no assetBaseUrl, should block all external HTTPS url() values (existing default)', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://pagespace-published.t3.tigrisfiles.io/assets/abc"); }</style>',
    });
    expect(out).not.toContain('pagespace-published.t3.tigrisfiles.io');
    expect(out).toContain('url("")');
  });

  it('given assetBaseUrl with trailing slash, should derive host correctly and allow it', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://cdn.example.com/assets/x"); }</style>',
      assetBaseUrl: 'https://cdn.example.com/',
    });
    expect(out).toContain('https://cdn.example.com/assets/x');
  });

  it('given a non-HTTPS assetBaseUrl, should reject it instead of allowlisting the host', () => {
    expect(() => renderPublishedPage({
      html: '<style>body { background: url("http://cdn.example.com/assets/x"); }</style>',
      assetBaseUrl: 'http://cdn.example.com',
    })).toThrow(/HTTPS/i);
  });

  it('given an assetBaseUrl with credentials, should reject it instead of allowlisting the host', () => {
    expect(() => renderPublishedPage({
      html: '<style>body { background: url("https://cdn.example.com/assets/x"); }</style>',
      assetBaseUrl: 'https://user:pass@cdn.example.com',
    })).toThrow(/origin/i);
  });
});
