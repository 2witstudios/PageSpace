import { describe, it, expect } from 'vitest';
import { renderCanvasDocument, deriveDescription, escapeHtml, BASELINE_CSP, BASELINE_RESET } from '../render-document';

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

  it('given pageUrl but no ogDescription, should omit og:description', () => {
    const out = renderCanvasDocument({ html: '<p>x</p>', pageUrl: 'https://acme.pagespace.site/p' });
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
});
