import { describe, it, expect } from 'vitest';
import { resolvePublishedMeta } from '../resolve-published-meta';

const BODY = '<p>The quick brown fox jumps over the lazy dog.</p>';

describe('resolvePublishedMeta — title', () => {
  it('prefers the override title over the page title', () => {
    const meta = resolvePublishedMeta({ override: { title: 'Override' }, pageTitle: 'Page', body: BODY });
    expect(meta.title).toBe('Override');
  });

  it('trims the override title', () => {
    const meta = resolvePublishedMeta({ override: { title: '  Spaced  ' }, pageTitle: 'Page', body: BODY });
    expect(meta.title).toBe('Spaced');
  });

  it('falls back to the page title when the override is blank/whitespace', () => {
    const meta = resolvePublishedMeta({ override: { title: '   ' }, pageTitle: 'Page', body: BODY });
    expect(meta.title).toBe('Page');
  });

  it('falls back to the page title when no override is given', () => {
    const meta = resolvePublishedMeta({ pageTitle: 'Page', body: BODY });
    expect(meta.title).toBe('Page');
  });

  it('is undefined when neither override nor page title is set', () => {
    const meta = resolvePublishedMeta({ body: BODY });
    expect(meta.title).toBeUndefined();
  });
});

describe('resolvePublishedMeta — ogImageUrl', () => {
  it('prefers the override image over canvas + drive default', () => {
    const meta = resolvePublishedMeta({
      override: { ogImageUrl: 'https://o.example/o.png' },
      canvasMeta: { ogImageUrl: 'https://c.example/c.png' },
      driveDefaultOgImageUrl: 'https://d.example/d.png',
      body: BODY,
    });
    expect(meta.ogImageUrl).toBe('https://o.example/o.png');
  });

  it('falls back to the canvas image when no override', () => {
    const meta = resolvePublishedMeta({
      canvasMeta: { ogImageUrl: 'https://c.example/c.png' },
      driveDefaultOgImageUrl: 'https://d.example/d.png',
      body: BODY,
    });
    expect(meta.ogImageUrl).toBe('https://c.example/c.png');
  });

  it('falls back to the drive default when neither override nor canvas set one', () => {
    const meta = resolvePublishedMeta({
      driveDefaultOgImageUrl: 'https://d.example/d.png',
      body: BODY,
    });
    expect(meta.ogImageUrl).toBe('https://d.example/d.png');
  });

  it('is undefined when no source supplies an image', () => {
    const meta = resolvePublishedMeta({ body: BODY });
    expect(meta.ogImageUrl).toBeUndefined();
  });

  it('treats a blank override image as no override and falls through', () => {
    const meta = resolvePublishedMeta({
      override: { ogImageUrl: '  ' },
      driveDefaultOgImageUrl: 'https://d.example/d.png',
      body: BODY,
    });
    expect(meta.ogImageUrl).toBe('https://d.example/d.png');
  });
});

describe('resolvePublishedMeta — description', () => {
  it('prefers the override description over canvas + derived', () => {
    const meta = resolvePublishedMeta({
      override: { description: 'Author blurb' },
      canvasMeta: { ogDescription: 'Canvas blurb' },
      body: BODY,
    });
    expect(meta.description).toBe('Author blurb');
  });

  it('falls back to the canvas og:description when no override', () => {
    const meta = resolvePublishedMeta({
      canvasMeta: { ogDescription: 'Canvas blurb' },
      body: BODY,
    });
    expect(meta.description).toBe('Canvas blurb');
  });

  it('falls back to a description derived from the body when nothing else is set', () => {
    const meta = resolvePublishedMeta({ body: BODY });
    expect(meta.description).toBe('The quick brown fox jumps over the lazy dog.');
  });

  it('treats a blank override description as no override and falls through', () => {
    const meta = resolvePublishedMeta({
      override: { description: '   ' },
      canvasMeta: { ogDescription: 'Canvas blurb' },
      body: BODY,
    });
    expect(meta.description).toBe('Canvas blurb');
  });
});

describe('resolvePublishedMeta — robots', () => {
  it('returns noindex when noindex is true', () => {
    expect(resolvePublishedMeta({ noindex: true, body: BODY }).robots).toBe('noindex');
  });

  it('returns index, follow when noindex is false', () => {
    expect(resolvePublishedMeta({ noindex: false, body: BODY }).robots).toBe('index, follow');
  });

  it('returns index, follow by default', () => {
    expect(resolvePublishedMeta({ body: BODY }).robots).toBe('index, follow');
  });
});
