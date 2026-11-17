import { describe, it, expect } from 'vitest';
import { extractStoredFileReferenceIds, pageContentCanReferenceFiles, scanStoredFileReferences } from '../stored-file-references';

describe('extractStoredFileReferenceIds', () => {
  it('given /api/files/{id}/view, thumbnail and download references, should return each id once', () => {
    const content = [
      '<img src="/api/files/page-a/view">',
      '<img src="/api/files/page-b/thumbnail?w=200">',
      '<a href="/api/files/page-c/download?filename=x.pdf">x</a>',
      '![again](/api/files/page-a/view)',
    ].join('\n');

    expect(extractStoredFileReferenceIds(content).sort()).toEqual(['page-a', 'page-b', 'page-c']);
  });

  it('given an absolute URL on any host, should still return the id (the path is what the app serves)', () => {
    expect(extractStoredFileReferenceIds('<img src="https://app.example.com/api/files/page-a/view">')).toEqual(['page-a']);
  });

  it('given the /dashboard/{driveId}/{pageId}/view form, should return the page id', () => {
    expect(extractStoredFileReferenceIds("background: url('/dashboard/drive-1/page-z/view');")).toEqual(['page-z']);
  });

  it('given a content-hash id, should return it', () => {
    const hash = 'ab'.repeat(32);
    expect(extractStoredFileReferenceIds(`<img src="/api/files/${hash}/view">`)).toEqual([hash]);
  });

  it('given no internal file references, should return nothing', () => {
    expect(extractStoredFileReferenceIds('<p>see /api/filesystem and https://example.com/a.png</p>')).toEqual([]);
    expect(extractStoredFileReferenceIds('')).toEqual([]);
  });

  it('given a trailing slash (Next.js redirects it to the slashless route), should still return the id', () => {
    const content = [
      '<img src="/api/files/page-a/view/">',
      '<img src="/api/files/page-b/thumbnail/?w=1">',
      "url('/dashboard/drive-1/page-c/view/')",
    ].join('\n');
    expect(extractStoredFileReferenceIds(content).sort()).toEqual(['page-a', 'page-b', 'page-c']);
  });

  it('given percent-encoded ids or path segments (the router decodes them), should return the decoded id', () => {
    const content = [
      '<img src="/api/files/%70age-a/view">',
      '<img src="/api/files/page-b/%76iew">',
      '<img src="/api/files/page-c/view%2F">',
      "url('/dashboard/drive-1/%70age-d/view')",
    ].join('\n');
    expect(extractStoredFileReferenceIds(content).sort()).toEqual(['page-a', 'page-b', 'page-c', 'page-d']);
  });

  it('given HTML character references (resolved before the browser fetches), should return the decoded id', () => {
    const content = [
      '<img src="/api/files/pag&#101;-a/view">',
      '<img src="/api/files/page-b/v&#x69;ew">',
      '<img src="&sol;api&sol;files&sol;page-c&sol;view">',
      '<img src="/api/files/page-d&#47;view">',
      // An entity that decodes to a percent escape, which the router then decodes.
      '<img src="/api/files/&#37;70age-e/view">',
    ].join('\n');
    expect(extractStoredFileReferenceIds(content).sort()).toEqual(['page-a', 'page-b', 'page-c', 'page-d', 'page-e']);
  });

  it('given a longer path that merely starts like a reference, should not match it', () => {
    expect(extractStoredFileReferenceIds('/api/files/page-a/viewer')).toEqual([]);
  });
});

describe('scanStoredFileReferences', () => {
  it('given tab and newline character references inside an attribute URL (the URL parser strips them), should return the id', () => {
    const content = [
      '<img src="/api/files/pa&#9;ge-a/view">',
      '<img src="/api/files/page-b/vi&#10;ew">',
      '<img src="/api/fi&#13;les/page-c/view">',
      '<img src="/api/files/page-d/&Tab;view">',
      '<img src="/api/files/page-e/vi&NewLine;ew">',
    ].join('\n');
    const scan = scanStoredFileReferences(content);
    expect(scan.ids.sort()).toEqual(['page-a', 'page-b', 'page-c', 'page-d', 'page-e']);
    expect(scan.complete).toBe(true);
  });

  it('given literal tabs and newlines inside an attribute URL, should return the id', () => {
    const scan = scanStoredFileReferences('<img src="/api/files/page-a\t/vi\new">');
    expect(scan.ids).toEqual(['page-a']);
    expect(scan.complete).toBe(true);
  });

  it('given mixed-case path segments, should return the id', () => {
    const scan = scanStoredFileReferences('<img src="/API/Files/page-a/VIEW"><a href="/api/FILES/page-b/Download">x</a>');
    expect(scan.ids.sort()).toEqual(['page-a', 'page-b']);
    expect(scan.complete).toBe(true);
  });

  it('given percent-encoded segments mixed with character references, should return the id', () => {
    const scan = scanStoredFileReferences('<img src="/api/%66iles/pa&#9;%67e-a/%76iew">');
    expect(scan.ids).toEqual(['page-a']);
    expect(scan.complete).toBe(true);
  });

  it('given protocol-relative, backslashed and dot-segment URLs (normalised as the browser does), should return the id', () => {
    const content = [
      '<img src="//cdn.example.com/api/files/page-a/view">',
      '<img src="\\api\\files\\page-b\\view">',
      '<img src="/api/x/../files/page-c/view">',
    ].join('\n');
    expect(scanStoredFileReferences(content).ids.sort()).toEqual(['page-a', 'page-b', 'page-c']);
  });

  it('given srcset candidates, data attributes and inline style url() with CSS escapes, should return every id', () => {
    const content = [
      '<img srcset="/api/files/page-a/view 1x, /api/files/page-b/thumbnail 2x">',
      '<div data-src="/api/files/page-c/view"></div>',
      '<div style="background-image: url(&quot;/api/files/page-d/view&quot;)"></div>',
      '<div style="background: url(/api/files/\\70 age-e/view)"></div>',
      '<style>.x { background: url("/api/files/page-f/view") } @import "/api/files/page-g/download";</style>',
    ].join('\n');
    const scan = scanStoredFileReferences(content);
    expect(scan.ids.sort()).toEqual(['page-a', 'page-b', 'page-c', 'page-d', 'page-e', 'page-f', 'page-g']);
    expect(scan.complete).toBe(true);
  });

  it('given content with no reference, should be complete and empty', () => {
    expect(scanStoredFileReferences('<p>see /api/filesystem and https://example.com/a.png</p>')).toEqual({ ids: [], complete: true });
    expect(scanStoredFileReferences('')).toEqual({ ids: [], complete: true });
  });

  it('given an api/files/ occurrence no extracted id accounts for, should report the scan incomplete (fail closed)', () => {
    // A zero-width character the URL parser keeps: not served as written, but
    // the backstop cannot tell, so the copy is refused as unverifiable.
    expect(scanStoredFileReferences('<img src="/api/files/pa&#8203;ge-a/view">').complete).toBe(false);
    // An encoding the parser path doesn't model (a reference inside script text).
    expect(scanStoredFileReferences('<script>load("/api/fi" + "les/x")</script><p>api/files/</p>').complete).toBe(false);
    // Whitespace inside the path outside any attribute.
    expect(scanStoredFileReferences('<p>/api/ files/page-a/view</p>').complete).toBe(false);
  });

  it('given an unclosed url( followed by a long whitespace run, should return promptly (no catastrophic backtracking)', () => {
    const started = performance.now();
    scanStoredFileReferences(`<p style="background:url(${' '.repeat(20000)}"></p>`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('given CSS string URLs (image-set) and meta refresh targets, should return the id', () => {
    const content = [
      "<div style=\"background-image:image-set('/dashboard/d/page-a/vi\\65 w' 1x)\"></div>",
      '<style>div{background:-webkit-image-set("/api/files/page-b/view" 1x)}</style>',
      '<meta http-equiv="refresh" content="0;url=/dashboard/d/page-c/vi&#9;ew">',
    ].join('\n');
    const scan = scanStoredFileReferences(content);
    expect(scan.ids.sort()).toEqual(['page-a', 'page-b', 'page-c']);
    expect(scan.complete).toBe(true);
  });

  it('given a dashboard /view reference no extracted id accounts for, should report the scan incomplete', () => {
    expect(scanStoredFileReferences('<p>/dashboard/d/ page-a/view</p>').complete).toBe(false);
    expect(scanStoredFileReferences('<div style="x:image-set(\'/dashboard/d/\\66 oo/view\' 1x)"></div>').ids).toEqual(['foo']);
  });

  it('given a dashboard link that is not a /view embed, should stay complete', () => {
    expect(scanStoredFileReferences('<a href="/dashboard/drive-1/page-a">open</a>')).toEqual({ ids: [], complete: true });
  });

  it('given JavaScript string escapes in script text, should resolve them and return the id', () => {
    expect(scanStoredFileReferences('<script>new Image().src="/api\\u002ffiles\\u002fpage-a/view"</script>')).toEqual({ ids: ['page-a'], complete: true });
    expect(scanStoredFileReferences('<script>x="\\x2fdashboard\\x2fd\\x2fpage-a\\x2fview"</script>')).toEqual({ ids: ['page-a'], complete: true });
  });

  it('given JavaScript escapes that only the backstop can peel, should report the scan incomplete', () => {
    expect(scanStoredFileReferences('<script>x="/api\\u002f fil\\x65s/page-a/view"</script>').complete).toBe(false);
  });

  it('given CSS string line continuations (backslash-newline, removed by the CSS tokenizer), should return the id', () => {
    const content = [
      '<div style="background-image: url(&quot;/api/fi\\\nles/page-a/view&quot;)"></div>',
      "<style>.x { background: url('/api/files/page-b/vi\\\r\new') }</style>",
      '<style>.y { background: image-set("/dashboard/d/page-c/vi\\\few" 1x) }</style>',
    ].join('\n');
    const scan = scanStoredFileReferences(content);
    expect(scan.ids.sort()).toEqual(['page-a', 'page-b', 'page-c']);
    expect(scan.complete).toBe(true);
  });

  it('given a line continuation in free text, should join it (over-finding is safe) and return the id', () => {
    expect(scanStoredFileReferences('<p>/api/fi\\\nles/page-a/view</p>')).toEqual({ ids: ['page-a'], complete: true });
  });

  it('given a JavaScript escape in a handler attribute that the token scan cannot resolve, should report the scan incomplete', () => {
    expect(scanStoredFileReferences('<img onerror="this.src=\'/api/\\u0066iles/ page-a/view\'">').complete).toBe(false);
  });

  it('given dot segments in free text (script bodies, markdown), should normalise them as the browser does and return the id', () => {
    const content = [
      '<script>new Image().src="/api/./files/page-a/view"</script>',
      '<script>fetch(\'/api/%2e/files/page-b/thumbnail\')</script>',
      '![x](/api/x/%2E%2e/files/page-c/download)',
      '<script>u = `https://cdn.example.com/dashboard/d/./page-d/view`</script>',
    ].join('\n');
    const scan = scanStoredFileReferences(content);
    expect(scan.ids.sort()).toEqual(['page-a', 'page-b', 'page-c', 'page-d']);
    expect(scan.complete).toBe(true);
  });

  it('given a dot-segment or doubled-slash mention the tokens cannot resolve, should report the scan incomplete', () => {
    expect(scanStoredFileReferences('<p>api/ ./files/page-a/view</p>').complete).toBe(false);
    expect(scanStoredFileReferences('<p>/api//files/page-a/view</p>').complete).toBe(false);
    expect(scanStoredFileReferences('<p>/dashboard/d/x/../ page-a/view</p>').complete).toBe(false);
  });

  it('given escaped slashes in a script URL followed by parent segments elsewhere, should still return the id', () => {
    const content = '<script>new Image().src="/api\\/files\\/page-a\\/view"</script><p>/../../../../</p>';
    expect(scanStoredFileReferences(content)).toEqual({ ids: ['page-a'], complete: true });
  });

  it('given a mention that only the uncollapsed skeleton shows, should report the scan incomplete', () => {
    // Collapsing `x/../` across the two regions would erase the first mention.
    expect(scanStoredFileReferences('<p>/api/ files/page-a/view</p><p>/../../../../</p>').complete).toBe(false);
  });

  it('given JavaScript single-character escapes inside a string literal, should resolve them as the script does', () => {
    const content = [
      '<script>a = "/api/fi\\les/page-a/view"</script>',
      '<script>b = "/api/files/page-b/vi\\tew"</script>',
      "<script>c = '/dashboard/d/page-c\\/view'</script>",
    ].join('\n');
    const scan = scanStoredFileReferences(content);
    expect(scan.ids.sort()).toEqual(['page-a', 'page-b', 'page-c']);
    expect(scan.complete).toBe(true);
  });

  it('given every occurrence accounted for, should report the scan complete', () => {
    const scan = scanStoredFileReferences('<img src="/api/files/page-a/view"> ![a](/api/files/page-a/view) <img src="/api/files/page-b/thumbnail">');
    expect(scan.complete).toBe(true);
  });
});

describe('pageContentCanReferenceFiles', () => {
  it('should be true for DOCUMENT and CANVAS pages only', () => {
    expect(pageContentCanReferenceFiles('DOCUMENT')).toBe(true);
    expect(pageContentCanReferenceFiles('CANVAS')).toBe(true);
    expect(pageContentCanReferenceFiles('FILE')).toBe(false);
    expect(pageContentCanReferenceFiles('AI_CHAT')).toBe(false);
  });
});
