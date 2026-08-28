import { Node, mergeAttributes } from '@tiptap/core';
import { simpleDataAttr } from '@/lib/editor/simple-data-attr';

/**
 * The `image` node — included in v1 despite the census finding only 9
 * instances on 2 pages. That count is a tautology: the editor has never had
 * an image node, so no document could contain one. Images are wanted and
 * simply unbuilt (`md:image` already appears in markdown source; ~4,000
 * markdown documents migrate onto this surface in Phase K and would flatten
 * on seed without it). Adding a node after documents exist is Class B
 * (version skew); including it now is free.
 *
 * Holds a FILE REFERENCE, never a URL. Every image the census found points at
 * internal storage (`pagespace-file`, relative paths) — no external hosts. A
 * signed URL written into a CRDT is permanent, expiring and leaky at once: it
 * outlives its own validity and carries a credential in the document. The
 * node stores `fileId`; resolving it to a renderable URL happens at render
 * time (a later leaf), not here.
 */
export const ImageNode = Node.create({
  name: 'image',

  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      fileId: simpleDataAttr('fileId', 'data-file-id'),
      // NOT simpleDataAttr: `alt=""` is a meaningful accessibility signal
      // (an explicitly decorative image), distinct from "no alt set" —
      // simpleDataAttr's `|| null` would collapse that signal to the same
      // null as a missing attribute, and a screen reader treats the two
      // differently. Preserve '' through both parse and render.
      alt: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('alt'),
        renderHTML: (attributes: Record<string, unknown>) => {
          const alt = attributes.alt;
          return alt === null || alt === undefined ? {} : { alt };
        },
      },
      width: simpleDataAttr('width', 'data-width'),
      height: simpleDataAttr('height', 'data-height'),
    };
  },

  // Deliberately `img[data-file-id]` only — an `<img src="...">` written by
  // something other than this node (e.g. hand-authored HTML with an external
  // URL) does not parse as an `image` node, because there is nothing to
  // resolve that URL to a `fileId`. It falls through to raw-HTML handling
  // (still an open decision — see COLLAB_SCHEMA_VERSION v1 leaf), not this
  // node.
  parseHTML() {
    return [{ tag: 'img[data-file-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  },

  /**
   * `tiptap-markdown` falls back to its own bundled default for any node
   * NAME it recognizes that doesn't provide `storage.markdown` itself — and
   * it ships its own `image` node with that exact name, whose default
   * serializer is `prosemirror-markdown`'s `defaultMarkdownSerializer.nodes.image`:
   * `node.attrs.src.replace(...)`. This node has no `src` (file reference
   * only, never a URL — see the class docstring), so without this override
   * `getMarkdown()` THROWS (`Cannot read properties of undefined`) the
   * moment a markdown-mode document contains an image, not merely emits bad
   * output.
   *
   * `fileId` is always null here: markdown-it's built-in image token parses
   * `![alt](src)` into `{ src, alt, title }`, none of which is `fileId`, so
   * `src`/`title` are silently dropped by ProseMirror's attribute
   * construction and `fileId` never gets set from markdown source. There is
   * no URL-to-`fileId` ingestion pipeline yet (Phase K, a later leaf) — so
   * serializing back writes nothing for this node rather than fabricating a
   * URL or reintroducing the crash. That is a real fidelity loss for
   * existing `md:image` content, but it is the SAME "flattens on seed"
   * limitation already named in this file's class docstring — this fix
   * makes that flattening happen cleanly (silently drop the node) instead
   * of crashing every markdown-mode `getMarkdown()` call.
   */
  addStorage() {
    return {
      markdown: {
        serialize() {
          // Nothing safe to emit — see docstring above.
        },
        parse: {
          // markdown-it's default image rule; addAttributes() above governs
          // which of its output attrs this node actually keeps (only `alt`).
        },
      },
    };
  },
});
