/**
 * Direct round-trip coverage for each COLLAB_SCHEMA_VERSION v1 schema
 * addition, at the node/mark level — narrower than the census's document-diff
 * tests (`census/__tests__/round-trip.test.ts`), which prove these additions
 * stop the census reporting them as dropped, but not what each one's stored
 * shape actually looks like.
 */
import { describe, it, expect } from 'vitest';
import { getSchema, generateHTML, generateJSON } from '@tiptap/core';
import { collabExtensions } from '../collab-schema';

const extensions = collabExtensions();
const schema = getSchema(extensions);

function roundTrip(html: string): string {
  return generateHTML(generateJSON(html, extensions), extensions);
}

describe('image node', () => {
  it('round-trips a data-file-id image, preserving the file reference', () => {
    const html = '<img data-file-id="file_abc123" alt="a diagram">';
    const out = roundTrip(html);
    expect(out).toContain('data-file-id="file_abc123"');
  });

  it('never stores src — only a file reference', () => {
    const doc = generateJSON('<img data-file-id="file_abc123">', extensions);
    const imageNode = JSON.stringify(doc).includes('"type":"image"');
    expect(imageNode).toBe(true);
    // The rendered HTML must not carry a `src` attribute pointing anywhere —
    // there is nothing in the node's attrs to resolve one from, by design.
    const out = roundTrip('<img data-file-id="file_abc123">');
    expect(out).not.toContain('src=');
  });

  it('does not parse a plain <img src="..."> as the image node (no file reference to store)', () => {
    const doc = generateJSON('<p>before</p><img src="https://example.test/a.png">', extensions);
    expect(JSON.stringify(doc)).not.toContain('"type":"image"');
  });
});

describe('taskList / taskItem', () => {
  it('round-trips a checked task item', () => {
    const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li></ul>';
    const doc = generateJSON(html, extensions);
    const json = JSON.stringify(doc);
    expect(json).toContain('"type":"taskList"');
    expect(json).toContain('"type":"taskItem"');
    expect(json).toContain('"checked":true');
  });
});

describe('heading levels 4-6', () => {
  it.each([4, 5, 6])('preserves <h%s> instead of flattening to <p>', (level) => {
    const html = `<h${level}>heading</h${level}>`;
    const doc = generateJSON(html, extensions);
    const json = JSON.stringify(doc);
    expect(json).toContain(`"level":${level}`);
  });
});

describe('highlight mark', () => {
  it('round-trips <mark>', () => {
    const doc = generateJSON('<p><mark>x</mark></p>', extensions);
    expect(JSON.stringify(doc)).toContain('"type":"highlight"');
  });
});

describe('textAlign', () => {
  it('preserves text-align on paragraph', () => {
    const doc = generateJSON('<p style="text-align: center">x</p>', extensions);
    expect(JSON.stringify(doc)).toContain('"textAlign":"center"');
  });

  it('preserves text-align on heading', () => {
    const doc = generateJSON('<h2 style="text-align: right">x</h2>', extensions);
    expect(JSON.stringify(doc)).toContain('"textAlign":"right"');
  });
});

describe('blockId / changeId / changeType (block-id.ts)', () => {
  it('defaults to null on a fresh paragraph node', () => {
    const paragraphType = schema.nodes.paragraph;
    const node = paragraphType.create();
    expect(node.attrs.blockId).toBeNull();
    expect(node.attrs.changeId).toBeNull();
    expect(node.attrs.changeType).toBeNull();
  });

  it('round-trips blockId/changeId/changeType via data-* attributes', () => {
    const html = '<p data-block-id="b1" data-change-id="c1" data-change-type="insertion">x</p>';
    const doc = generateJSON(html, extensions);
    const json = JSON.stringify(doc);
    expect(json).toContain('"blockId":"b1"');
    expect(json).toContain('"changeId":"c1"');
    expect(json).toContain('"changeType":"insertion"');
  });

  it('applies to every declared block node type, not a subset', () => {
    for (const name of ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'horizontalRule', 'table', 'taskList', 'taskItem', 'image']) {
      const nodeType = schema.nodes[name];
      expect(nodeType, `schema is missing node "${name}"`).toBeDefined();
      expect(Object.keys(nodeType.spec.attrs ?? {}), `"${name}" is missing blockId`).toContain('blockId');
    }
  });
});

describe('comment / insertion / deletion marks (collab-marks.ts)', () => {
  it('comment carries threadId only', () => {
    expect(Object.keys(schema.marks.comment.spec.attrs ?? {})).toEqual(['threadId']);
  });

  it('insertion carries authorId and changeId', () => {
    expect(Object.keys(schema.marks.insertion.spec.attrs ?? {}).sort()).toEqual(['authorId', 'changeId']);
  });

  it('deletion carries authorId and changeId', () => {
    expect(Object.keys(schema.marks.deletion.spec.attrs ?? {}).sort()).toEqual(['authorId', 'changeId']);
  });

  it('round-trips a comment mark with its threadId', () => {
    const html = '<p><span data-thread-id="t1">x</span></p>';
    const doc = generateJSON(html, extensions);
    const json = JSON.stringify(doc);
    expect(json).toContain('"type":"comment"');
    expect(json).toContain('"threadId":"t1"');
  });

  it('round-trips an insertion mark with authorId and changeId', () => {
    const html = '<p><span data-change-type="insertion" data-author-id="u1" data-change-id="c1">x</span></p>';
    const doc = generateJSON(html, extensions);
    const json = JSON.stringify(doc);
    expect(json).toContain('"type":"insertion"');
    expect(json).toContain('"authorId":"u1"');
    expect(json).toContain('"changeId":"c1"');
  });
});

describe('FontFormatting deletion did not lose fontFamily/fontSize', () => {
  it('TextStyleKit alone still round-trips fontFamily and fontSize', () => {
    const html = '<p><span style="font-family: Arial; font-size: 14px">x</span></p>';
    const doc = generateJSON(html, extensions);
    const json = JSON.stringify(doc);
    expect(json).toContain('"fontFamily":"Arial"');
    expect(json).toContain('"fontSize":"14px"');
  });
});
