import CodeBlock from '@tiptap/extension-code-block';

/**
 * The `codeBlock` node's schema-affecting shape only: the `language` attribute
 * and its HTML round-trip. No `addNodeView` (React) or `addProseMirrorPlugins`
 * (Shiki highlighting) — both are DOM/React-dependent and live in
 * `CodeBlockShiki` (`CodeBlockShikiExtension.ts`), which extends this node for
 * the client. `collabExtensions()` uses this node directly so the frozen
 * schema can be constructed in Node with no DOM.
 */
export const CodeBlockNode = CodeBlock.extend({
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
});
