import { Mark } from '@tiptap/core';

/**
 * Comment, insertion and deletion marks — schema-only, inert. No commands, no
 * toolbar wiring, no read side; they exist so `COLLAB_SCHEMA_VERSION` v1 can
 * represent comment threads and inline tracked changes once those features
 * land, without a Class B (version-skew) schema change at that point.
 *
 * `comment` carries `threadId` only, deliberately. A mark attribute holding
 * mutable state (e.g. "resolved") would force a CRDT write per state change
 * and put resolution into the Yjs merge path. Resolution state belongs in
 * Postgres, keyed by `threadId` — this mark is purely an anchor.
 *
 * `insertion`/`deletion` are the INLINE half of tracked changes — character
 * runs added/removed by a suggestion. They cannot represent an inserted
 * paragraph or a changed heading level; that's what the block-level
 * `changeId`/`changeType` attributes in `block-id.ts` are for. The two are a
 * pair: a suggestion mode needs both the mark (what changed within a block)
 * and the block attribute (what changed about a block itself).
 */

export const CommentMark = Mark.create({
  name: 'comment',

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-thread-id'),
        renderHTML: (attributes) => {
          if (!attributes.threadId) return {};
          return { 'data-thread-id': attributes.threadId };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-thread-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },
});

export const InsertionMark = Mark.create({
  name: 'insertion',

  addAttributes() {
    return {
      authorId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-author-id'),
        renderHTML: (attributes) => {
          if (!attributes.authorId) return {};
          return { 'data-author-id': attributes.authorId };
        },
      },
      changeId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-change-id'),
        renderHTML: (attributes) => {
          if (!attributes.changeId) return {};
          return { 'data-change-id': attributes.changeId };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-change-type="insertion"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-change-type': 'insertion' }, 0];
  },
});

export const DeletionMark = Mark.create({
  name: 'deletion',

  addAttributes() {
    return {
      authorId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-author-id'),
        renderHTML: (attributes) => {
          if (!attributes.authorId) return {};
          return { 'data-author-id': attributes.authorId };
        },
      },
      changeId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-change-id'),
        renderHTML: (attributes) => {
          if (!attributes.changeId) return {};
          return { 'data-change-id': attributes.changeId };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-change-type="deletion"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-change-type': 'deletion' }, 0];
  },
});
