import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node } from '@tiptap/pm/model';

export const findPluginKey = new PluginKey<FindPluginState>('find');

interface FindPluginState {
  query: string;
  matches: { from: number; to: number }[];
  currentIndex: number;
  decorations: DecorationSet;
}

function findMatches(doc: Node, query: string): { from: number; to: number }[] {
  if (!query) return [];
  const matches: { from: number; to: number }[] = [];
  const queryLower = query.toLowerCase();
  const queryLen = query.length;

  // Process each inline-content block, coalescing adjacent text nodes so that
  // queries spanning marks (e.g. "hel**lo**" searched as "hello") are found.
  doc.descendants((node, pos) => {
    if (!node.isBlock || !node.inlineContent) return;

    // Build a buffer of all text within this block and a parallel doc-position map.
    // Flush the buffer on non-text inline nodes (e.g. mentions, images) so that
    // `foo[mention]bar` cannot match a query like `foobar` across the boundary.
    let docPositions: number[] = [];
    let buffer = '';

    const flushBuffer = () => {
      let idx = buffer.indexOf(queryLower);
      while (idx !== -1) {
        matches.push({ from: docPositions[idx], to: docPositions[idx + queryLen - 1] + 1 });
        idx = buffer.indexOf(queryLower, idx + 1);
      }
      buffer = '';
      docPositions = [];
    };

    node.forEach((child, offset) => {
      if (child.isText && child.text) {
        buffer += child.text.toLowerCase();
        const childPos = pos + 1 + offset;
        for (let i = 0; i < child.text.length; i++) {
          docPositions.push(childPos + i);
        }
      } else if (buffer) {
        flushBuffer();
      }
    });
    flushBuffer();

    return false; // don't descend into inline children — we've handled them above
  });

  return matches;
}

function buildDecorations(
  doc: Node,
  matches: { from: number; to: number }[],
  currentIndex: number,
): DecorationSet {
  if (!matches.length) return DecorationSet.empty;

  const decorations = matches.map((match, i) =>
    Decoration.inline(match.from, match.to, {
      class: i === currentIndex ? 'find-highlight find-highlight-current' : 'find-highlight',
    }),
  );

  return DecorationSet.create(doc, decorations);
}

export const FindPlugin = new Plugin<FindPluginState>({
  key: findPluginKey,

  state: {
    init() {
      return { query: '', matches: [], currentIndex: 0, decorations: DecorationSet.empty };
    },

    apply(tr, pluginState, _, newState) {
      const meta = tr.getMeta(findPluginKey) as
        | { query: string; currentIndex: number }
        | undefined;

      if (meta !== undefined) {
        const matches = findMatches(newState.doc, meta.query);
        const idx = matches.length ? Math.min(meta.currentIndex, matches.length - 1) : 0;
        const decorations = buildDecorations(newState.doc, matches, idx);
        return { query: meta.query, matches, currentIndex: idx, decorations };
      }

      if (tr.docChanged && pluginState.query) {
        const matches = findMatches(newState.doc, pluginState.query);
        const idx = matches.length
          ? Math.min(pluginState.currentIndex, matches.length - 1)
          : 0;
        const decorations = buildDecorations(newState.doc, matches, idx);
        return { ...pluginState, matches, currentIndex: idx, decorations };
      }

      return {
        ...pluginState,
        decorations: pluginState.decorations.map(tr.mapping, tr.doc),
      };
    },
  },

  props: {
    decorations(state) {
      return findPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
    },
  },
});

export function dispatchFind(view: EditorView, query: string, currentIndex: number): void {
  view.dispatch(view.state.tr.setMeta(findPluginKey, { query, currentIndex }));
}

export function getPluginMatches(state: EditorState): { from: number; to: number }[] {
  return findPluginKey.getState(state)?.matches ?? [];
}

export const FindExtension = Extension.create({
  name: 'find',
  addProseMirrorPlugins() {
    return [FindPlugin];
  },
});
