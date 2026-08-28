import { Node, mergeAttributes } from '@tiptap/core';

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
      fileId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-file-id'),
        renderHTML: (attributes) => {
          if (!attributes.fileId) return {};
          return { 'data-file-id': attributes.fileId };
        },
      },
      alt: {
        default: null,
        parseHTML: (element) => element.getAttribute('alt'),
        renderHTML: (attributes) => {
          if (!attributes.alt) return {};
          return { alt: attributes.alt };
        },
      },
      width: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-width'),
        renderHTML: (attributes) => {
          if (!attributes.width) return {};
          return { 'data-width': attributes.width };
        },
      },
      height: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-height'),
        renderHTML: (attributes) => {
          if (!attributes.height) return {};
          return { 'data-height': attributes.height };
        },
      },
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
});
