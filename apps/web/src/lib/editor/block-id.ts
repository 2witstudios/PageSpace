import { Extension } from '@tiptap/core';

/**
 * Every top-level block node type `blockId` and the tracked-change attributes
 * below apply to. Chosen to match what a document's structural diff actually
 * operates over: the direct children of `doc`, plus `listItem`/`taskItem`
 * (children of `bulletList`/`orderedList`/`taskList`, but themselves the unit
 * a "changed list item" tracked-change would attach to).
 */
export const BLOCK_NODE_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'horizontalRule',
  'table',
  'image',
] as const;

/**
 * `blockId`: a stable identifier on every block node, independent of
 * ProseMirror position (which shifts on every edit). Comments anchor on
 * `blockId` + `Y.RelativePosition` rather than the (deleted-in-favour-of-this)
 * text-offset anchoring in `packages/lib/src/content/anchoring/` — see the
 * `nellzsa0ww4vhpq9qft8f8pi` decision.
 *
 * `changeId`/`changeType` are the BLOCK half of tracked changes. `insertion`/
 * `deletion` (`collab-marks.ts`) are inline marks and cannot represent an
 * inserted paragraph or a changed heading level — most of what a suggestion
 * mode does. A block carrying `changeType: 'insertion'` and a shared
 * `changeId` records that the whole block is a pending suggestion.
 *
 * All three default to `null` and are wired to no UI/commands in this PR —
 * schema-only, inert, like the marks in `collab-marks.ts`.
 */
export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_NODE_TYPES],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: (attributes) => {
              if (!attributes.blockId) return {};
              return { 'data-block-id': attributes.blockId };
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
          // 'insertion' | 'deletion' | null
          changeType: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-change-type'),
            renderHTML: (attributes) => {
              if (!attributes.changeType) return {};
              return { 'data-change-type': attributes.changeType };
            },
          },
        },
      },
    ];
  },
});
