import { Window } from 'happy-dom';

/**
 * The DOM every HTML-touching conversion in this package parses into and
 * serializes out of.
 *
 * **happy-dom, as a production `dependency`** — decided on the projections
 * leaf (`ta44dhnzeda8unluhugtqp1n`), and the reasoning matters more than the
 * choice:
 *
 * 1. It is the declared peer dependency of `@tiptap/html@3.23.5`, the
 *    sanctioned TipTap v3 Node path. zeed-dom was the v2 path; jsdom is
 *    neither.
 * 2. jsdom 25 resolves in this repo today — but only *transitively, through
 *    vitest*. That is exactly what makes it a trap rather than a convenience:
 *    `apps/collab` is a production Node service, and a DOM that arrives via a
 *    test tool's dependency chain disappears on a devDependency prune, a
 *    vitest major, or a Docker production install. It would fail in the image,
 *    not in CI.
 *
 * **The DOM implementation is part of the schema's contract, not an
 * implementation detail.** Several `parseHTML` functions in the frozen schema
 * read the *DOM*, not the source string — `TextStyleKit`'s `getStyleProperty`
 * fallbacks, `MarkdownTightLists`' `!element.querySelector('p')`,
 * `CodeBlockNode`'s `element.querySelector('code')`. DOM implementations
 * canonicalise `style` declarations and attribute quoting differently, so two
 * processes can agree on `SCHEMA_HASH` and still disagree on what a document
 * *is*. `__tests__/cross-dom-parse-equality.test.ts` holds this shim against
 * a real browser DOM over the construct corpus for that reason.
 *
 * Deliberately NOT installed as `globalThis.window`/`globalThis.document`.
 * `@tiptap/html`'s `generateJSON`/`generateHTML` reach for those globals;
 * this package drives `prosemirror-model`'s `DOMParser`/`DOMSerializer`
 * directly with an explicit element instead, so importing this module in a
 * Node service mutates nothing process-wide and two conversions can never
 * race on a shared document.
 */
export interface DomWorkspace {
  /** Parses stored markup into a detached element. */
  parse(html: string): HTMLElement;
  /** A fresh detached element to serialize a document into. */
  empty(): HTMLElement;
  /** The document `DOMSerializer` creates its nodes from. */
  document: Document;
  /** Releases the underlying window's async tasks. Always call it. */
  close(): void;
}

/**
 * happy-dom's `Window` is structurally the DOM's but is not `lib.dom`'s type,
 * and the two universes do not meet. Casting at this one boundary — where the
 * decision is recorded — beats spreading `as unknown as` through every caller.
 */
export function createDomWorkspace(): DomWorkspace {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      disableComputedStyleRendering: true,
    },
  });

  const empty = (): HTMLElement =>
    window.document.createElement('div') as unknown as HTMLElement;

  return {
    empty,
    parse(html: string): HTMLElement {
      const container = empty();
      container.innerHTML = html;
      return container;
    },
    document: window.document as unknown as Document,
    close(): void {
      void window.happyDOM.close();
    },
  };
}

/**
 * Runs `body` against a workspace and closes it afterwards, including on
 * throw. Every conversion in this package that needs a DOM goes through here:
 * a leaked happy-dom `Window` holds timers, and the collab service converts
 * once per flush for the life of the process.
 */
export function withDomWorkspace<T>(body: (workspace: DomWorkspace) => T): T {
  const workspace = createDomWorkspace();
  try {
    return body(workspace);
  } finally {
    workspace.close();
  }
}
