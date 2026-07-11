import { describe, it, expect } from 'vitest';
import { renderCanvasDocument, deriveDescription, escapeHtml, BASELINE_CSP, BASELINE_RESET, THEME_BRIDGE_SCRIPT } from '../render-document';

describe('renderCanvasDocument', () => {
  it('given any input, should return a full HTML document', () => {
    const out = renderCanvasDocument({ html: '<p>hello</p>' });
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<html lang="en">');
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

  it('should allowlist ONLY Google Fonts and nothing broader (exact baseline policy)', () => {
    // Pin the whole policy: any broadening of style-src/font-src (e.g. an extra
    // host or a wildcard) flips this test, not just the two intended additions.
    expect(BASELINE_CSP).toBe(
      "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('should default to the unchanged BASELINE_CSP when no formActionOrigin is given', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>' });
    expect(out).toContain(`content="${BASELINE_CSP}"`);
  });

  it('should scope form-action/connect-src to the given formActionOrigin, never a wildcard', () => {
    const out = renderCanvasDocument({ html: '<form></form>', formActionOrigin: 'https://app.pagespace.ai' });
    expect(out).toContain("form-action 'self' https://app.pagespace.ai");
    expect(out).toContain('connect-src https://app.pagespace.ai');
    expect(out).not.toContain('form-action *');
  });

  it('should embed the Google Fonts hosts in the rendered CSP <meta> when the author links them', () => {
    const out = renderCanvasDocument({
      html: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap"><p>x</p>',
    });
    // Assert against the CSP meta's content value specifically — not the whole
    // HTML, which would also match the author-supplied <link> and give a false pass.
    const csp = out.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] ?? '';
    expect(csp).toContain("style-src 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain('font-src https://fonts.gstatic.com');
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

describe('renderCanvasDocument — theme bridge', () => {
  it('given injectThemeBridge: true, should inject the bridge script inside <head>', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', injectThemeBridge: true });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain(THEME_BRIDGE_SCRIPT);
  });

  it('given no injectThemeBridge, should NOT inject the bridge script', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>' });
    expect(out).not.toContain('pagespace-theme');
  });

  it('given injectThemeBridge: true, the bridge should use prefers-color-scheme for standalone (published) dark mode', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', injectThemeBridge: true });
    expect(out).toContain('prefers-color-scheme');
    expect(out).toContain('matchMedia');
    // Should apply on load...
    expect(out).toContain('mq.matches');
    // ...and listen for changes
    expect(out).toContain("'change'");
  });

  it('given injectThemeBridge: true, the bridge should listen for postMessage (in-app override) and request the theme on load', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', injectThemeBridge: true });
    expect(out).toContain("e.data.type==='pagespace-theme'");
    expect(out).toContain("postMessage({type:'pagespace-theme-request'}");
  });

  it('given injectThemeBridge: true, the bridge should toggle a dark class (matching next-themes convention)', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', injectThemeBridge: true });
    expect(out).toContain("'dark'");
  });
});

describe('renderCanvasDocument — favicon', () => {
  it('given faviconBaseUrl, should include favicon.ico link in <head>', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', faviconBaseUrl: 'https://pagespace.ai' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<link rel="icon" type="image/x-icon" href="https://pagespace.ai/favicon.ico"');
  });

  it('given faviconBaseUrl, should include 32x32 PNG favicon in <head>', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', faviconBaseUrl: 'https://pagespace.ai' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<link rel="icon" type="image/png" sizes="32x32" href="https://pagespace.ai/favicon-32x32.png"');
  });

  it('given faviconBaseUrl, should include apple-touch-icon in <head>', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', faviconBaseUrl: 'https://pagespace.ai' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<link rel="apple-touch-icon" sizes="180x180" href="https://pagespace.ai/apple-touch-icon.png"');
  });

  it('given no faviconBaseUrl, should emit no favicon link tags', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>' });
    expect(out).not.toContain('rel="icon"');
    expect(out).not.toContain('rel="apple-touch-icon"');
  });

  it('given faviconBaseUrl with trailing slash, should not produce double slash in href', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', faviconBaseUrl: 'https://pagespace.ai/' });
    expect(out).not.toContain('//favicon.ico');
    expect(out).toContain('href="https://pagespace.ai/favicon.ico"');
  });

  it('given faviconBaseUrl, favicon links must appear inside <head> not <body>', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', faviconBaseUrl: 'https://pagespace.ai' });
    const bodyStart = out.indexOf('<body>');
    const faviconIdx = out.indexOf('rel="icon"');
    expect(faviconIdx).toBeGreaterThanOrEqual(0);
    expect(faviconIdx).toBeLessThan(bodyStart);
  });

  it('given faviconHref, should emit a single link rel=icon with that href', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', faviconHref: 'https://cdn.example.com/icon.ico' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<link rel="icon" href="https://cdn.example.com/icon.ico">');
    expect(head).not.toContain('favicon.ico');
    expect(head).not.toContain('favicon-32x32');
    expect(head).not.toContain('apple-touch-icon');
  });

  it('given faviconHref, should prefer it over faviconBaseUrl', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      faviconHref: 'https://cdn.example.com/icon.ico',
      faviconBaseUrl: 'https://pagespace.ai',
    });
    expect(out).toContain('href="https://cdn.example.com/icon.ico"');
    expect(out).not.toContain('favicon.ico');
  });

  it('given faviconHref containing a double-quote, should HTML-escape it', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', faviconHref: 'https://cdn.example.com/"evil".ico' });
    expect(out).not.toContain('"evil"');
    expect(out).toContain('&quot;evil&quot;');
  });
});

describe('renderCanvasDocument — OG meta tags', () => {
  it('given pageUrl, should emit og:title in <head>', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', title: 'My Page', pageUrl: 'https://acme.pagespace.site/my-page' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta property="og:title" content="My Page"');
  });

  it('given pageUrl, should emit og:type="website" in <head>', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: 'https://acme.pagespace.site/my-page' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta property="og:type" content="website"');
  });

  it('given pageUrl, should emit og:url set to the exact pageUrl', () => {
    const url = 'https://acme.pagespace.site/my-page';
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: url });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain(`<meta property="og:url" content="${url}"`);
  });

  it('given pageUrl, should emit og:site_name="PageSpace"', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: 'https://acme.pagespace.site/my-page' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta property="og:site_name" content="PageSpace"');
  });

  it('given pageUrl + ogImageUrl, should emit og:image, og:image:width, og:image:height', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      pageUrl: 'https://acme.pagespace.site/my-page',
      ogImageUrl: 'https://pagespace.ai/og-image.png',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta property="og:image" content="https://pagespace.ai/og-image.png"');
    expect(head).toContain('<meta property="og:image:width" content="1200"');
    expect(head).toContain('<meta property="og:image:height" content="630"');
  });

  it('given pageUrl but no ogImageUrl, should omit og:image tags', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: 'https://acme.pagespace.site/my-page' });
    expect(out).not.toContain('og:image');
  });

  it('given no pageUrl, should emit no OG tags at all', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', title: 'My Page' });
    expect(out).not.toContain('og:');
  });

  it('given a title with HTML special chars, should HTML-escape the og:title content', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', title: '<b>bold & bright</b>', pageUrl: 'https://acme.pagespace.site/p' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('content="&lt;b&gt;bold &amp; bright&lt;/b&gt;"');
    expect(head).not.toContain('content="<b>');
  });

  it('given pageUrl, OG meta tags must appear inside <head> not <body>', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: 'https://acme.pagespace.site/my-page' });
    const bodyStart = out.indexOf('<body>');
    const ogIdx = out.indexOf('og:title');
    expect(ogIdx).toBeGreaterThanOrEqual(0);
    expect(ogIdx).toBeLessThan(bodyStart);
  });
});

describe('renderCanvasDocument — OG meta injection safety', () => {
  it('given pageUrl containing a double-quote, should HTML-escape it in og:url', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: 'https://evil.com?a="<b>' });
    expect(out).not.toContain('"<b>');
    expect(out).toContain('content="https://evil.com?a=&quot;&lt;b&gt;"');
  });

  it('given ogImageUrl containing a double-quote, should HTML-escape it in og:image', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      pageUrl: 'https://acme.pagespace.site/p',
      ogImageUrl: 'https://pagespace.ai/img.png?a="bad',
    });
    expect(out).not.toContain('"bad');
    expect(out).toContain('content="https://pagespace.ai/img.png?a=&quot;bad"');
  });

  it('given faviconBaseUrl containing a double-quote, should HTML-escape it in href', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', faviconBaseUrl: 'https://evil.com"onload="x' });
    expect(out).not.toContain('"onload=');
    expect(out).toContain('href="https://evil.com&quot;onload=&quot;x/favicon.ico"');
  });
});

describe('renderCanvasDocument — og:description', () => {
  it('given pageUrl and ogDescription, should emit og:description in <head>', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      pageUrl: 'https://acme.pagespace.site/p',
      ogDescription: 'Published on PageSpace',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta property="og:description" content="Published on PageSpace"');
  });

  it('given pageUrl but no ogDescription, should fall back to the derived meta description', () => {
    const out = renderCanvasDocument({
      html: '<p>The quick brown fox.</p>',
      pageUrl: 'https://acme.pagespace.site/p',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta property="og:description" content="The quick brown fox."');
  });

  it('given pageUrl + explicit description but no ogDescription, should use that description for og:description', () => {
    const out = renderCanvasDocument({
      html: '<p>body text</p>',
      pageUrl: 'https://acme.pagespace.site/p',
      description: 'Author meta description',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta property="og:description" content="Author meta description"');
  });

  it('given pageUrl but no description anywhere, should omit og:description', () => {
    const out = renderCanvasDocument({ html: '', pageUrl: 'https://acme.pagespace.site/p' });
    expect(out).not.toContain('og:description');
  });

  it('given ogDescription with HTML special chars, should escape them', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      pageUrl: 'https://acme.pagespace.site/p',
      ogDescription: 'A & B <draft>',
    });
    expect(out).toContain('content="A &amp; B &lt;draft&gt;"');
    expect(out).not.toContain('content="A & B');
  });

  it('given no pageUrl, should not emit og:description even if ogDescription is set', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', ogDescription: 'Published on PageSpace' });
    expect(out).not.toContain('og:description');
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

describe('renderCanvasDocument — <html lang>', () => {
  it('given no lang, should default the html lang to "en"', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>' });
    expect(out).toContain('<html lang="en">');
  });

  it('given an explicit lang, should use it', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', lang: 'fr' });
    expect(out).toContain('<html lang="fr">');
    expect(out).not.toContain('<html lang="en">');
  });

  it('given a blank lang, should fall back to "en"', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', lang: '   ' });
    expect(out).toContain('<html lang="en">');
  });

  it('given a lang with a double-quote, should HTML-escape it', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', lang: 'en"><script>' });
    expect(out).not.toContain('<html lang="en"><script>');
    expect(out).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('renderCanvasDocument — CSP nonce for inherited outer policy', () => {
  // The in-app iframe's srcDoc document unconditionally inherits the parent
  // (embedder) document's CSP, in addition to its own <meta> CSP. When the app
  // shell's CSP requires a nonce on script-src, author <script> tags need a
  // matching nonce to keep running under the outer, inherited policy.
  it('given a nonce, should stamp it onto preserved author <script> tags', () => {
    const out = renderCanvasDocument({
      html: '<script>console.log("hi");</script>',
      nonce: 'abc123==',
    });
    expect(out).toContain('<script nonce="abc123==">console.log("hi");</script>');
  });

  it('given no nonce (e.g. the publish pipeline), should leave author <script> tags byte-for-byte unchanged', () => {
    const out = renderCanvasDocument({
      html: '<script>console.log("hi");</script>',
    });
    expect(out).toContain('<script>console.log("hi");</script>');
    expect(out).not.toContain('nonce=');
  });

  it('given an author script that already declares its own (foreign/stale) nonce attribute, should REPLACE it with the current nonce, not leave it alone', () => {
    // A foreign nonce (e.g. HTML pasted from a different nonce-protected site)
    // can never match the inherited outer CSP's nonce-source — leaving it in
    // place would still get the script blocked, defeating the whole point of
    // this function. Replace it (not duplicate) so the tag stays valid HTML
    // with exactly one nonce attribute that actually matches.
    const out = renderCanvasDocument({
      html: '<script nonce="author-nonce">console.log("hi");</script>',
      nonce: 'app-nonce==',
    });
    expect(out).toContain('<script nonce="app-nonce==">console.log("hi");</script>');
    expect(out).not.toContain('author-nonce');
    // nonce="app-nonce==" itself contains the substring "nonce=", so count by
    // the quoted attribute form (`nonce="`) to avoid matching inside the value.
    expect((out.match(/nonce="/g) ?? []).length).toBe(1);
  });

  it('given a script with a data-nonce (or aria-nonce) attribute, should NOT mistake it for a real nonce attribute — it stamps a real one alongside', () => {
    // A bare `\b` word-boundary regex matches right after a hyphen too, so
    // `data-nonce="foo"` was previously (incorrectly) treated as "already has
    // a nonce" and skipped — leaving the script with no real nonce attribute
    // at all, still blocked by the inherited CSP.
    const out = renderCanvasDocument({
      html: '<script data-nonce="foo" aria-nonce="bar">console.log("hi");</script>',
      nonce: 'app-nonce==',
    });
    expect(out).toContain('<script nonce="app-nonce==" data-nonce="foo" aria-nonce="bar">console.log("hi");</script>');
    // data-nonce/aria-nonce values are untouched — only a real nonce attribute was added.
    expect(out).toContain('data-nonce="foo"');
    expect(out).toContain('aria-nonce="bar"');
    expect((out.match(/ nonce="app-nonce=="/g) ?? []).length).toBe(1);
  });

  it('given another attribute whose OWN value contains the substring " nonce=", should NOT corrupt that attribute — it stamps a real nonce alongside, untouched', () => {
    // A raw substring search for `nonce=` (rather than walking real,
    // whole attributes) would match INSIDE this attribute's quoted value
    // and truncate/re-quote it mid-string, corrupting the tag.
    const out = renderCanvasDocument({
      html: '<script data-log="utm_source=x nonce=stale123">console.log("hi");</script>',
      nonce: 'app-nonce==',
    });
    expect(out).toContain('<script nonce="app-nonce==" data-log="utm_source=x nonce=stale123">console.log("hi");</script>');
    expect((out.match(/ nonce="app-nonce=="/g) ?? []).length).toBe(1);
  });

  // Regression guard for CodeQL js/polynomial-redos (CWE-1333): the
  // attribute-tokenizer's leading-whitespace group must stay a single `\s`,
  // not `\s+` — the latter is O(n²) on a long whitespace run with no valid
  // attribute name following, since the regex engine retries the match at
  // every position with a shrinking whitespace span before giving up.
  it('given a script tag padded with a large run of whitespace and no valid attribute name, should stamp the nonce in near-linear time (not quadratic)', () => {
    const padding = ' '.repeat(50_000);
    const html = `<script${padding}>console.log("hi");</script>`;
    const start = performance.now();
    const out = renderCanvasDocument({ html, nonce: 'n' });
    const elapsedMs = performance.now() - start;
    expect(out).toContain('console.log("hi")');
    // Linear-time regex finishes in low single-digit ms even at 50k chars;
    // a reintroduced O(n²) `\s+` blows well past 1s at this size.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('given a bare (valueless) nonce attribute, should replace it with a real one, not duplicate it', () => {
    const out = renderCanvasDocument({
      html: '<script nonce defer src="x.js"></script>',
      nonce: 'app-nonce==',
    });
    expect(out).toContain('<script nonce="app-nonce==" defer src="x.js"></script>');
    // "app-nonce==" itself contains "nonce" as a substring, and the bare
    // attribute is a literal `nonce` token — count the quoted attribute form
    // only, which is unambiguous.
    expect((out.match(/nonce="/g) ?? []).length).toBe(1);
    expect(out).not.toContain('nonce defer'); // the original bare token is gone, not left behind
  });

  it('given a nonce with HTML-significant characters, should escape it in the stamped attribute', () => {
    const out = renderCanvasDocument({
      html: '<script>x()</script>',
      nonce: '"><script>alert(1)</script>',
    });
    expect(out).toContain('nonce="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('given multiple author <script> tags, should stamp the nonce onto each', () => {
    const out = renderCanvasDocument({
      html: '<script>a()</script><p>x</p><script>b()</script>',
      nonce: 'n1',
    });
    expect((out.match(/nonce="n1"/g) ?? []).length).toBe(2);
  });
});

describe('deriveDescription', () => {
  it('given plain text shorter than the limit, should return it unchanged', () => {
    expect(deriveDescription('Hello world')).toBe('Hello world');
  });

  it('given HTML, should strip tags and collapse whitespace', () => {
    expect(deriveDescription('<h1>Hi</h1>\n\n  <p>there   friend</p>')).toBe('Hi there friend');
  });

  it('given <script> and <style> blocks, should drop their contents entirely', () => {
    const html = '<style>.x{color:red}</style><p>Visible copy</p><script>const t="hidden";</script>';
    expect(deriveDescription(html)).toBe('Visible copy');
  });

  it('given HTML entities, should decode them (so re-escaping does not double-encode)', () => {
    expect(deriveDescription('<p>Tom &amp; Jerry &lt;3 &#39;quotes&#39;</p>')).toBe("Tom & Jerry <3 'quotes'");
  });

  it('given text longer than ~155 chars, should truncate at a word boundary and add an ellipsis', () => {
    const long = 'word '.repeat(60).trim(); // 60 words, ~299 chars
    const out = deriveDescription(long);
    expect(out.length).toBeLessThanOrEqual(156);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('wor…'); // no mid-word cut
  });

  it('given empty/whitespace-only content, should return an empty string', () => {
    expect(deriveDescription('   \n\t ')).toBe('');
    expect(deriveDescription('')).toBe('');
  });
});

describe('renderCanvasDocument — SEO meta (published only)', () => {
  it('given pageUrl, should emit a canonical link with the exact published URL', () => {
    const url = 'https://acme.pagespace.site/my-page';
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: url });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain(`<link rel="canonical" href="${url}">`);
  });

  it('given pageUrl and no robots, should default robots to "index, follow"', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: 'https://acme.pagespace.site/p' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta name="robots" content="index, follow">');
  });

  it('given robots="noindex", should emit that value', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: 'https://acme.pagespace.site/p', robots: 'noindex' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta name="robots" content="noindex">');
    expect(head).not.toContain('index, follow');
  });

  it('given a description input, should emit it as meta name=description', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      pageUrl: 'https://acme.pagespace.site/p',
      description: 'A crafted summary',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta name="description" content="A crafted summary">');
  });

  it('given no description input, should derive the meta description from the body text', () => {
    const out = renderCanvasDocument({
      html: '<h1>Welcome</h1><p>This page is about cats.</p>',
      pageUrl: 'https://acme.pagespace.site/p',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta name="description" content="Welcome This page is about cats.">');
  });

  it('given a description with HTML special chars, should escape it', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      pageUrl: 'https://acme.pagespace.site/p',
      description: 'A & B <draft>',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('content="A &amp; B &lt;draft&gt;"');
  });

  it('given no pageUrl, should emit no canonical/robots/description SEO tags (in-app rendering unchanged)', () => {
    const out = renderCanvasDocument({ html: '<p>some text</p>', title: 'My Page' });
    expect(out).not.toContain('rel="canonical"');
    expect(out).not.toContain('name="robots"');
    expect(out).not.toContain('name="description"');
  });

  it('given pageUrl, SEO tags must appear inside <head> not <body>', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: 'https://acme.pagespace.site/p' });
    const bodyStart = out.indexOf('<body>');
    expect(out.indexOf('rel="canonical"')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('rel="canonical"')).toBeLessThan(bodyStart);
    expect(out.indexOf('name="robots"')).toBeLessThan(bodyStart);
  });
});

describe('renderCanvasDocument — JSON-LD structured data', () => {
  function extractJsonLd(out: string): unknown {
    const m = out.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no JSON-LD script found');
    return JSON.parse(m[1]);
  }

  it('given pageUrl, should emit a valid JSON-LD script with WebSite + WebPage nodes', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      title: 'My Page',
      pageUrl: 'https://acme.pagespace.site/my-page',
      description: 'A summary',
    });
    const data = extractJsonLd(out) as { '@context': string; '@graph': Array<Record<string, string>> };
    expect(data['@context']).toBe('https://schema.org');
    const types = data['@graph'].map((n) => n['@type']);
    expect(types).toContain('WebSite');
    expect(types).toContain('WebPage');
    const webPage = data['@graph'].find((n) => n['@type'] === 'WebPage')!;
    expect(webPage.name).toBe('My Page');
    expect(webPage.url).toBe('https://acme.pagespace.site/my-page');
    expect(webPage.description).toBe('A summary');
    const webSite = data['@graph'].find((n) => n['@type'] === 'WebSite')!;
    expect(webSite.url).toBe('https://acme.pagespace.site');
  });

  it('given a title containing </script>, should not break out of the JSON-LD script element', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      title: 'Pwn </script><script>alert(1)</script>',
      pageUrl: 'https://acme.pagespace.site/p',
    });
    // The raw closing tag must be escaped inside the JSON-LD block.
    const m = out.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)!;
    expect(m[1]).not.toContain('</script>');
    // …and the JSON is still valid and round-trips the title.
    const data = JSON.parse(m[1]) as { '@graph': Array<Record<string, string>> };
    const webPage = data['@graph'].find((n) => n['@type'] === 'WebPage')!;
    expect(webPage.name).toBe('Pwn </script><script>alert(1)</script>');
  });

  it('given no pageUrl, should emit no JSON-LD', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', title: 'My Page' });
    expect(out).not.toContain('application/ld+json');
  });
});

describe('renderCanvasDocument — Twitter Card', () => {
  it('given pageUrl, should emit twitter:card=summary_large_image and twitter:title', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', title: 'My Page', pageUrl: 'https://acme.pagespace.site/p' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(head).toContain('<meta name="twitter:title" content="My Page">');
  });

  it('given ogImageUrl, should reuse it for twitter:image', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      pageUrl: 'https://acme.pagespace.site/p',
      ogImageUrl: 'https://pagespace.ai/og.png',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta name="twitter:image" content="https://pagespace.ai/og.png">');
  });

  it('given ogDescription, should reuse it for twitter:description', () => {
    const out = renderCanvasDocument({
      html: '<p>x</p>',
      pageUrl: 'https://acme.pagespace.site/p',
      ogDescription: 'Shared blurb',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta name="twitter:description" content="Shared blurb">');
  });

  it('given no ogDescription but derivable body text, should fall back to the SEO description for twitter:description', () => {
    const out = renderCanvasDocument({
      html: '<p>Body sentence here.</p>',
      pageUrl: 'https://acme.pagespace.site/p',
    });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<meta name="twitter:description" content="Body sentence here.">');
  });

  it('given a title with special chars, should escape twitter:title', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', title: '<b>bold & bright</b>', pageUrl: 'https://acme.pagespace.site/p' });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('name="twitter:title" content="&lt;b&gt;bold &amp; bright&lt;/b&gt;"');
  });

  it('given no pageUrl, should emit no twitter tags', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', title: 'My Page' });
    expect(out).not.toContain('twitter:');
  });

  // Hardened closing-tag matching: junk/whitespace/bogus attributes before `>`
  // must not let style/script content escape the alternation (CodeQL 204-205).
  it('given a <style> closed with junk before `>` (`</style\\n foo>`), should still hoist+sanitize and drop it from the body', () => {
    const out = renderCanvasDocument({
      html: '<style>body { background: url("https://evil.com/pixel.png"); }</style\n foo><p>x</p>',
    });
    // External url() was routed through sanitizeCSS (hoisted to <head>), not leaked.
    expect(out).not.toContain('https://evil.com');
    expect(out).toContain('url("")');
    // The whole <style>…</style\n foo> block was consumed — no <style> survives in the body.
    expect(out).toContain('</head><body><p>x</p></body>');
  });

  it('given a <script> closed with a bogus attribute (`</script bar>`), should PRESERVE the script verbatim', () => {
    const out = renderCanvasDocument({
      html: '<div id="app"></div><script>document.getElementById("app").textContent = "hi";</script bar>',
    });
    // Scripts are preserved by design (sandboxed iframe + strict CSP); the junk
    // close must not cause the script body to be mistaken for a <style>.
    expect(out).toContain('<script>');
    expect(out).toContain('document.getElementById("app")');
  });

  // A hyphen/colon after the tag name is NOT a valid end-tag delimiter, so a
  // hyphenated token like `</script-template>` must NOT terminate the <script>.
  // Otherwise the parser would resume outside the script and wrongly hoist a
  // later inner <style>, corrupting an author script that should stay verbatim.
  it('given `</script-template>` text inside a <script>, should PRESERVE the whole script and NOT hoist a <style> that follows inside it', () => {
    const out = renderCanvasDocument({
      html: '<script>const t = "</script-template>"; const css = "<style>.x{color:red}</style>";</script><p>x</p>',
    });
    // The entire script (including the inner <style> text) is preserved verbatim.
    expect(out).toContain('const t = "</script-template>"');
    expect(out).toContain('const css = "<style>.x{color:red}</style>"');
    // The inner <style> was script text, not a real stylesheet — it must NOT be
    // sanitized/hoisted into <head>. There is no real author stylesheet here, so
    // the (single, baseline) <style> in <head> carries no author `.x` rule.
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).not.toContain('.x{color:red}');
  });

  it('given a custom element `<script-template>`, should NOT treat it as a <script> open', () => {
    const out = renderCanvasDocument({
      html: '<script-template><style>.y{color:blue}</style></script-template>',
    });
    // `<script-template>` is a normal (custom) element, so the <style> inside it
    // IS a real stylesheet — it should be sanitized + hoisted, not preserved raw.
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('.y');
    expect(out).not.toContain('<style>.y{color:blue}</style>');
  });

  describe('given author html that is already a full standalone document', () => {
    it('should unwrap it to a single, non-nested document (not double-wrap it)', () => {
      const out = renderCanvasDocument({
        html:
          '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>Author Title</title>\n' +
          '<meta name="description" content="Author description">\n</head>\n<body>\n<nav>hi</nav>\n</body>\n</html>',
      });
      // Exactly one doctype/html/head/body — no stray structural tags nested
      // inside the generated <body>.
      expect(out.match(/<!doctype html>/gi) ?? []).toHaveLength(1);
      expect(out.match(/<html(?=[\s>])/gi) ?? []).toHaveLength(1);
      expect(out.match(/<head(?=[\s>])/gi) ?? []).toHaveLength(1);
      expect(out.match(/<body(?=[\s>])/gi) ?? []).toHaveLength(1);
      expect(out.match(/<meta charset/gi) ?? []).toHaveLength(1);
      // The author's <head> (title/description) is discarded here — it is a
      // higher-level concern (SEO meta extraction) — but the body content survives.
      expect(out).toContain('<nav>hi</nav>');
      expect(out).not.toContain('Author Title');
    });

    it('given a full document with no explicit <body> tag, should still strip the wrapper', () => {
      const out = renderCanvasDocument({
        html: '<!DOCTYPE html><html><head><title>x</title></head><p>orphan</p></html>',
      });
      expect(out.match(/<!doctype html>/gi) ?? []).toHaveLength(1);
      expect(out.match(/<html(?=[\s>])/gi) ?? []).toHaveLength(1);
      expect(out).toContain('<p>orphan</p>');
    });

    it('given a bare fragment (the common case), should pass through unchanged', () => {
      const out = renderCanvasDocument({ html: '<div>fragment</div>' });
      expect(out.match(/<html(?=[\s>])/gi) ?? []).toHaveLength(1);
      expect(out).toContain('<div>fragment</div>');
    });

    it('given a <style> block inside the <head>, should hoist it into the generated <head> (not drop it)', () => {
      const out = renderCanvasDocument({
        html:
          '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>Author Title</title>\n' +
          '<style>body { color: red; }</style>\n</head>\n<body>\n<nav>hi</nav>\n</body>\n</html>',
      });
      // Still a single, non-nested document.
      expect(out.match(/<!doctype html>/gi) ?? []).toHaveLength(1);
      expect(out.match(/<html(?=[\s>])/gi) ?? []).toHaveLength(1);
      expect(out.match(/<head(?=[\s>])/gi) ?? []).toHaveLength(1);
      expect(out.match(/<body(?=[\s>])/gi) ?? []).toHaveLength(1);
      // The author's head <style> rule survives, hoisted into the generated
      // <head> (same treatment as a body-level <style>) — not silently dropped.
      const headEnd = out.indexOf('</head>');
      expect(out.slice(0, headEnd)).toContain('body { color: red; }');
      expect(out).toContain('<nav>hi</nav>');
    });
  });
});
