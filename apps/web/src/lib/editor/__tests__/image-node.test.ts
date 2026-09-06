/**
 * Regression test for a CodeRabbit finding on PR #2515: `simpleDataAttr`
 * collapses `alt=""` to `null`, destroying the "explicitly decorative image"
 * accessibility signal an empty alt represents. `alt` uses a bespoke
 * attribute definition instead — this locks in that it survives a
 * parse/render round trip.
 */
import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { ImageNode } from '../image-node';

function parseAlt(html: string): unknown {
  const schema = getSchema([StarterKit, ImageNode]);
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const doc = PMDOMParser.fromSchema(schema).parse(dom.body);
  let alt: unknown;
  doc.descendants((node) => {
    if (node.type.name === 'image') {
      alt = node.attrs.alt;
    }
  });
  return alt;
}

describe('ImageNode alt attribute', () => {
  it('preserves an explicit empty alt (decorative image signal) through parse', () => {
    expect(parseAlt('<img data-file-id="f1" alt="" />')).toBe('');
  });

  it('preserves a non-empty alt through parse', () => {
    expect(parseAlt('<img data-file-id="f1" alt="a photo" />')).toBe('a photo');
  });

  it('defaults to null when alt is absent', () => {
    expect(parseAlt('<img data-file-id="f1" />')).toBe(null);
  });

  it('renders an explicit empty alt back onto the element (not omitted)', () => {
    const schema = getSchema([StarterKit, ImageNode]);
    const node = schema.nodes.image.create({ fileId: 'f1', alt: '' });
    const rendered = node.type.spec.toDOM?.(node) as [string, Record<string, unknown>];
    expect(rendered[1]).toHaveProperty('alt', '');
  });

  it('omits alt when null (not rendered as alt="null")', () => {
    const schema = getSchema([StarterKit, ImageNode]);
    const node = schema.nodes.image.create({ fileId: 'f1', alt: null });
    const rendered = node.type.spec.toDOM?.(node) as [string, Record<string, unknown>];
    expect(rendered[1]).not.toHaveProperty('alt');
  });
});
