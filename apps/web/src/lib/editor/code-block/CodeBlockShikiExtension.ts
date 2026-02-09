import CodeBlock from '@tiptap/extension-code-block';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { tokenizeCode, type ShikiTheme } from './shiki-highlighter';
import { tokensToDecorationSpecs, specsToDecorations } from './token-decorations';
import { LanguageSelector } from './LanguageSelector';

const highlightPluginKey = new PluginKey('codeBlockShikiHighlight');
const DEBOUNCE_MS = 300;

function detectTheme(): ShikiTheme {
  if (typeof document === 'undefined') return 'one-light';
  return document.documentElement.classList.contains('dark')
    ? 'one-dark-pro'
    : 'one-light';
}

interface CodeBlockInfo {
  from: number;
  to: number;
  language: string;
  text: string;
}

function findCodeBlocks(doc: PMNode): CodeBlockInfo[] {
  const blocks: CodeBlockInfo[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      blocks.push({
        from: pos + 1, // +1 to skip the node opening
        to: pos + 1 + node.content.size,
        language: node.attrs.language || '',
        text: node.textContent,
      });
      return false; // don't descend into code blocks
    }
    return true;
  });
  return blocks;
}

function createHighlightPlugin(): Plugin {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let currentVersion = 0;

  return new Plugin({
    key: highlightPluginKey,
    state: {
      init(): DecorationSet {
        return DecorationSet.empty;
      },
      apply(tr: Transaction, oldDecorations: DecorationSet): DecorationSet {
        if (tr.getMeta(highlightPluginKey)) {
          return tr.getMeta(highlightPluginKey) as DecorationSet;
        }
        if (tr.docChanged) {
          return oldDecorations.map(tr.mapping, tr.doc);
        }
        return oldDecorations;
      },
    },
    view(editorView: EditorView) {
      function scheduleHighlight() {
        if (debounceTimer) clearTimeout(debounceTimer);
        const version = ++currentVersion;

        debounceTimer = setTimeout(async () => {
          if (version !== currentVersion) return;

          const { state } = editorView;
          const blocks = findCodeBlocks(state.doc);
          const theme = detectTheme();
          const allDecorations: Decoration[] = [];

          for (const block of blocks) {
            if (!block.language || !block.text) continue;
            try {
              const tokens = await tokenizeCode(block.text, block.language, theme);
              if (version !== currentVersion) return;
              const specs = tokensToDecorationSpecs(tokens, block.from);
              allDecorations.push(...specsToDecorations(specs));
            } catch {
              // skip blocks that fail to highlight
            }
          }

          if (version !== currentVersion) return;

          const decoSet = DecorationSet.create(
            editorView.state.doc,
            allDecorations
          );
          const tr = editorView.state.tr.setMeta(highlightPluginKey, decoSet);
          editorView.dispatch(tr);
        }, DEBOUNCE_MS);
      }

      // Initial highlight
      scheduleHighlight();

      return {
        update(view: EditorView, prevState: EditorState) {
          if (view.state.doc !== prevState.doc) {
            scheduleHighlight();
          }
        },
        destroy() {
          if (debounceTimer) clearTimeout(debounceTimer);
        },
      };
    },
    props: {
      decorations(state: EditorState) {
        return highlightPluginKey.getState(state) as DecorationSet;
      },
    },
  });
}

export const CodeBlockShiki = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: null,
        parseHTML: (element) => {
          const codeEl = element.querySelector('code');
          const classList = codeEl?.className || element.className || '';
          const match = classList.match(/language-(\S+)/);
          return match?.[1] || null;
        },
        renderHTML: (attributes) => {
          if (!attributes.language) return {};
          return { class: `language-${attributes.language}` };
        },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(LanguageSelector);
  },

  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), createHighlightPlugin()];
  },
});
