import { describe, it, expect } from 'vitest';
import { renderCanvasDocument, escapeHtml, BASELINE_CSP, BASELINE_RESET } from '../render-document';

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

  it('should emit a baseline reset that zeroes the body margin (no UA border/frame)', () => {
    const out = renderCanvasDocument({ html: '<div>x</div>' });
    expect(out).toContain('html,body{margin:0;padding:0;}');
  });

  it('baseline reset is scoped to html/body — no universal box-sizing or font override', () => {
    // A wider reset would silently reflow/restyle arbitrary author content on republish.
    expect(BASELINE_RESET).toBe('html,body{margin:0;padding:0;}');
    expect(BASELINE_RESET).not.toContain('box-sizing');
    expect(BASELINE_RESET).not.toContain('font-family');
  });

  it('should emit the baseline reset BEFORE the author CSS so author rules win', () => {
    const out = renderCanvasDocument({ html: '<style>body { margin: 40px; }</style><div>x</div>' });
    const resetIdx = out.indexOf('html,body{margin:0;padding:0;}');
    const authorIdx = out.indexOf('margin: 40px');
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(authorIdx).toBeGreaterThan(resetIdx);
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

  // Codex #2: a <style> block inside <script> source (e.g. a web-component
  // template literal) must NOT be treated as a real stylesheet — the script
  // must survive verbatim and the inline style text must NOT be hoisted/removed.
  it('given a <style> inside a <script> string, should preserve the script verbatim', () => {
    const script = `<script>const t = '<style>.x{color:red}</style>';document.body.innerHTML = t;</script>`;
    const out = renderCanvasDocument({ html: `${script}<p>x</p>` });
    expect(out).toContain(script);
    // The inline style text stays inside the script; the hoisted <head> <style> is empty.
    expect(out).toContain('</head><body>');
    expect(out).toContain('<head><meta charset');
    // No duplicated/hoisted .x rule outside the script.
    const headPart = out.slice(0, out.indexOf('</head>'));
    expect(headPart).not.toContain('.x{color:red}');
  });

  it('given a real <style> AND a <style> inside a <script>, should hoist only the real one', () => {
    const out = renderCanvasDocument({
      html: `<style>.real{color:blue}</style><script>const t='<style>.fake{color:red}</style>';</script>`,
    });
    const headPart = out.slice(0, out.indexOf('</head>'));
    expect(headPart).toContain('.real{color:blue}');
    expect(headPart).not.toContain('.fake');
    expect(out).toContain(`<script>const t='<style>.fake{color:red}</style>';</script>`);
  });

  // Codex #1: in-app iframe links (ordinary <a href> with no target) would
  // navigate the sandboxed frame itself; baseTarget injects <base target> so
  // they open a new tab instead.
  it('given baseTarget, should inject a <base target> so links open in a new context', () => {
    const out = renderCanvasDocument({ html: '<a href="https://example.com">x</a>', baseTarget: '_blank' });
    expect(out).toContain('<base target="_blank">');
  });

  it('given no baseTarget (published page), should NOT inject a <base> element', () => {
    const out = renderCanvasDocument({ html: '<a href="https://example.com">x</a>' });
    expect(out).not.toContain('<base');
  });
});

describe('renderCanvasDocument — allowedAssetHosts', () => {
  it('given allowedAssetHosts containing the CDN host, should preserve that host in CSS url()', () => {
    const out = renderCanvasDocument({
      html: '<style>body { background: url("https://cdn.example.com/assets/abc"); }</style>',
      allowedAssetHosts: ['cdn.example.com'],
    });
    expect(out).toContain('https://cdn.example.com/assets/abc');
    expect(out).not.toContain('url("")');
  });

  it('given allowedAssetHosts set, should still block non-matching HTTPS hosts in CSS url()', () => {
    const out = renderCanvasDocument({
      html: '<style>body { background: url("https://tracker.evil.com/px.gif"); }</style>',
      allowedAssetHosts: ['cdn.example.com'],
    });
    expect(out).not.toContain('tracker.evil.com');
    expect(out).toContain('url("")');
  });

  it('given allowedAssetHosts, should NOT affect HTML img src attributes — they are never sanitized', () => {
    const out = renderCanvasDocument({
      html: '<img src="https://cdn.example.com/photo.jpg">',
      allowedAssetHosts: ['cdn.example.com'],
    });
    expect(out).toContain('https://cdn.example.com/photo.jpg');
  });

  it('given allowedAssetHosts: [] (empty), should block all external HTTPS url() values', () => {
    const out = renderCanvasDocument({
      html: '<style>body { background: url("https://cdn.example.com/x.png"); }</style>',
      allowedAssetHosts: [],
    });
    expect(out).not.toContain('cdn.example.com');
    expect(out).toContain('url("")');
  });

  it('given no allowedAssetHosts field, should block all external HTTPS url() values (existing default)', () => {
    const out = renderCanvasDocument({
      html: '<style>body { background: url("https://cdn.example.com/x.png"); }</style>',
    });
    expect(out).not.toContain('cdn.example.com');
    expect(out).toContain('url("")');
  });
});
