import { describe, it, expect, afterAll } from 'vitest';
import { createDomWorkspace } from '../constructs';
import { classifyImageSource, htmlImageSources, IMAGE_SOURCE_KEYS } from '../images';

const workspace = createDomWorkspace();
afterAll(() => workspace.close());

describe('classifyImageSource', () => {
  it('names a data URI, the one source that cannot be carried into a Y.Doc', () => {
    // Not a size question: a CRDT keeps every version of every byte forever, so
    // base64 in a document is permanent whatever it weighs.
    expect(classifyImageSource('data:image/png;base64,iVBORw0KGgo=')).toEqual({
      bucket: IMAGE_SOURCE_KEYS.dataUri,
      host: null,
    });
    expect(classifyImageSource('DATA:image/png;base64,x').bucket).toBe(IMAGE_SOURCE_KEYS.dataUri);
  });

  it('recognises an image PageSpace already stores, absolute or relative', () => {
    for (const src of [
      '/api/files/abc123/view',
      '/api/files/abc123/thumbnail',
      'https://app.pagespace.test/api/files/abc123/view',
      '/api/files/abc123/view?width=200',
    ]) {
      expect(classifyImageSource(src)).toEqual({ bucket: IMAGE_SOURCE_KEYS.pagespaceFile, host: null });
    }
  });

  it('separates https from http, and keeps the host', () => {
    expect(classifyImageSource('https://images.example.test/a/b/c.png?token=secret')).toEqual({
      bucket: IMAGE_SOURCE_KEYS.externalHttps,
      host: 'images.example.test',
    });
    expect(classifyImageSource('http://old.example.test/a.png')).toEqual({
      bucket: IMAGE_SOURCE_KEYS.externalHttp,
      host: 'old.example.test',
    });
  });

  it('treats a scheme-relative URL as the https it becomes in production', () => {
    expect(classifyImageSource('//cdn.example.test/a.png')).toEqual({
      bucket: IMAGE_SOURCE_KEYS.externalHttps,
      host: 'cdn.example.test',
    });
  });

  it('reports a relative path, which resolves against nothing once migrated', () => {
    expect(classifyImageSource('./images/a.png')).toEqual({ bucket: IMAGE_SOURCE_KEYS.relative, host: null });
    expect(classifyImageSource('a.png')).toEqual({ bucket: IMAGE_SOURCE_KEYS.relative, host: null });
  });

  it('buckets blob: and file:, which only one browser on one machine can resolve', () => {
    expect(classifyImageSource('blob:https://app.test/9f2').bucket).toBe(IMAGE_SOURCE_KEYS.otherScheme);
    expect(classifyImageSource('file:///Users/someone/a.png').bucket).toBe(IMAGE_SOURCE_KEYS.otherScheme);
  });

  it('calls an empty src malformed rather than relative', () => {
    expect(classifyImageSource('   ')).toEqual({ bucket: IMAGE_SOURCE_KEYS.malformed, host: null });
  });
});

describe('what leaves this module', () => {
  // The census reports construct names and page ids, never content. A src is
  // content: it carries a filename, and a query string carries tokens.
  it('never returns the path, the query string or the filename', () => {
    const source = classifyImageSource('https://images.example.test/private/quarterly-results.png?sig=abc');
    expect(JSON.stringify(source)).not.toContain('quarterly-results');
    expect(JSON.stringify(source)).not.toContain('sig=abc');
    expect(JSON.stringify(source)).not.toContain('/private/');
  });

  it('drops even the host when the URL carries credentials', () => {
    expect(classifyImageSource('https://user:pw@internal.example.test/a.png')).toEqual({
      bucket: IMAGE_SOURCE_KEYS.externalHttps,
      host: null,
    });
  });

  it('reports the bare hostname, without the port or the userinfo', () => {
    expect(classifyImageSource('https://images.example.test:8443/a.png').host).toBe('images.example.test');
  });

  it('lower-cases the host so one host is one row', () => {
    expect(classifyImageSource('https://Images.Example.Test/a.png').host).toBe('images.example.test');
  });
});

describe('htmlImageSources', () => {
  it('classifies every <img> in a stored document', () => {
    const container = workspace.parse(
      '<p>a</p><img src="https://a.example.test/1.png"><img src="data:image/png;base64,x">',
    );
    expect(htmlImageSources(container).map((image) => image.bucket)).toEqual([
      IMAGE_SOURCE_KEYS.externalHttps,
      IMAGE_SOURCE_KEYS.dataUri,
    ]);
  });

  it('counts an <img> with no src rather than ignoring it', () => {
    const container = workspace.parse('<img alt="a">');
    expect(htmlImageSources(container)).toEqual([{ bucket: IMAGE_SOURCE_KEYS.malformed, host: null }]);
  });
});
