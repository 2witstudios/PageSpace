/**
 * Regression test for a Codex finding on PR #2515: `tiptap-markdown` falls
 * back to its own bundled `image` node's default markdown serializer for
 * ANY node named "image" that doesn't provide its own `storage.markdown` —
 * and that default (`prosemirror-markdown`'s `defaultMarkdownSerializer.nodes.image`)
 * does `node.attrs.src.replace(...)`. `ImageNode` has no `src` (file
 * reference only, never a URL), so `src` is `undefined` and
 * `undefined.replace(...)` THROWS — before the fix, `getMarkdown()` crashed
 * outright the moment a markdown-mode document contained an image, not
 * merely produced bad output.
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { ImageNode } from '../image-node';

type MarkdownStorage = { getMarkdown(): string };
type EditorStorageWithMarkdown = { markdown: MarkdownStorage };

function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as EditorStorageWithMarkdown).markdown.getMarkdown();
}

function createMarkdownEditor(markdown: string) {
  return new Editor({
    extensions: [StarterKit, Markdown, ImageNode],
    content: markdown,
  });
}

describe('ImageNode markdown serialization', () => {
  it('does not throw serializing a document containing a genuine image node', () => {
    // Markdown-parsed `![alt](src)` never produces an `image` node at all
    // (see the flattening test below) — the crash this guards against is
    // reached by a REAL image node instead: one inserted via the app's own
    // upload flow (attrs: { fileId }), in a document that also has the
    // (always-mounted) Markdown extension. That combination is exactly what
    // getMarkdown() (called on every edit, in every mode, per RichEditor's
    // onUpdate) hits.
    const editor = new Editor({
      extensions: [StarterKit, Markdown, ImageNode],
      content: { type: 'doc', content: [{ type: 'image', attrs: { fileId: 'f1' } }] },
    });
    expect(() => {
      getMarkdown(editor);
    }).not.toThrow();
    editor.destroy();
  });

  it('markdown-parsed image content does not survive into the document (the accepted "flattens on seed" limitation)', () => {
    // ImageNode is `group: 'block'`, but standard markdown image syntax
    // `![alt](src)` is INLINE — markdown-it/tiptap-markdown can't place a
    // block node where inline content is expected, so the image is dropped
    // rather than inserted with mismatched attrs. This is the exact
    // limitation this file's class docstring already names ("~4,000
    // markdown documents migrate onto this surface in Phase K and would
    // flatten on seed without it") — real ingestion is a later leaf, not
    // this PR's job. Asserting it explicitly so a future change to either
    // the node's `group` or the markdown bridging notices if this shifts.
    const editor = createMarkdownEditor('![a photo](https://example.com/x.png)');
    const json = editor.getJSON();
    const image = json.content?.find((n) => n.type === 'image');
    expect(image).toBeUndefined();
    editor.destroy();
  });

  it('round-trips a document with no images unaffected', () => {
    const editor = createMarkdownEditor('# Title\n\nSome text.');
    const markdown = getMarkdown(editor);
    expect(markdown).toContain('Title');
    expect(markdown).toContain('Some text.');
    editor.destroy();
  });
});
