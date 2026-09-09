import { Window } from 'happy-dom';

/**
 * Real HTML element names. Anything outside this set that a parser produced is
 * not markup the author wrote — it is an unescaped `<` in prose or a code
 * sample (`ActionResult<void>`, `<task-id>`), which every happy-dom parse
 * turns into an element of its own. Moved here (out of
 * `census/constructs.ts`, which this repo is going to delete once
 * `COLLAB_SCHEMA_VERSION` v1 is frozen) because the mislabelled-content-mode
 * backfill needs the exact same "does this contain real HTML" answer the
 * census measured, and needs it to survive after the census is gone.
 */
export const HTML_ELEMENT_NAMES = new Set<string>([
  'a','abbr','address','area','article','aside','audio','b','base','bdi','bdo','blockquote','body',
  'br','button','canvas','caption','cite','code','col','colgroup','data','datalist','dd','del',
  'details','dfn','dialog','div','dl','dt','em','embed','fieldset','figcaption','figure','footer',
  'form','h1','h2','h3','h4','h5','h6','head','header','hgroup','hr','html','i','iframe','img',
  'input','ins','kbd','label','legend','li','link','main','map','mark','menu','meta','meter','nav',
  'noscript','object','ol','optgroup','option','output','p','param','picture','pre','progress','q',
  'rp','rt','ruby','s','samp','script','search','section','select','slot','small','source','span',
  'strong','style','sub','summary','sup','table','tbody','td','template','textarea','tfoot','th',
  'thead','time','title','tr','track','u','ul','var','video','wbr','svg','math',
]);

/** Single marker for parser artefacts of unescaped `<` in text. */
export const UNESCAPED_ANGLE_BRACKET_KEY = 'text:unescaped-angle-bracket';

/**
 * The narrow slice of a parsed element this module actually reads. Kept to
 * exactly `tagName` + `querySelectorAll` on purpose: `census/constructs.ts`
 * needs a much richer shape (`empty()`, `document`, `textContent`, attribute
 * readers) for its own round-trip diffing, but that module is TEMPORARY BY
 * DESIGN (deleted once `COLLAB_SCHEMA_VERSION` v1 freezes) and this one is
 * meant to outlive it — a future Phase E seed-guard imports this module, not
 * the census. Widening this interface to fit the census's needs would bake
 * census-only requirements into the file that is supposed to survive census
 * deletion. `census/constructs.ts` owns its own richer workspace/window and
 * imports only `HTML_ELEMENT_NAMES`/`UNESCAPED_ANGLE_BRACKET_KEY` from here.
 */
export interface DomElement {
  tagName: string;
  querySelectorAll(selector: string): Iterable<DomElement>;
}

export interface DomWorkspace {
  /** Parses stored markup into a detached element. */
  parse(html: string): DomElement;
  close(): void;
}

/**
 * happy-dom rather than jsdom: it is the DOM `@tiptap/html@3` declares as its
 * peer, so "does this content contain a real HTML element" is answered by the
 * same parser the editor's own server-side round trip uses.
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

  return {
    parse(html: string): DomElement {
      const container = window.document.createElement('div') as unknown as DomElement & { innerHTML: string };
      container.innerHTML = html;
      return container;
    },
    close(): void {
      // close() aborts the window's async tasks on its way out; abort() as well
      // would just be the older, narrower half of the same call.
      void window.happyDOM.close();
    },
  };
}

/**
 * Whether a parsed document contains any element the author actually wrote,
 * as opposed to happy-dom's parse of an unescaped `<` in prose or a code
 * sample turning `ActionResult<void>` into an `<actionresult>` "element".
 */
export function hasRealHtmlElement(container: DomElement): boolean {
  for (const element of container.querySelectorAll('*')) {
    if (HTML_ELEMENT_NAMES.has(element.tagName.toLowerCase())) return true;
  }
  return false;
}

export type ClassifyContentResult =
  | { format: 'empty'; confident: true }
  | { format: 'html'; confident: true }
  | { format: 'markdown-source'; confident: true }
  /** The content could not be parsed at all — never guess, report and skip. */
  | { format: 'unknown'; confident: false; reason: string };

/**
 * Classifies stored `pages.content` as `html` or `markdown-source` **by
 * inspecting the content**, never by trusting `contentMode` — that column is
 * exactly what this classifier exists to check.
 *
 * `packages/lib`'s `detectPageContentFormat` was evaluated for this and is
 * NOT reused: it decides `html` from a boundary heuristic
 * (`trimmed.startsWith('<') && trimmed.endsWith('>')`) with no DOM parse and
 * no markdown category — `# heading\n\nmore text with a stray >` would
 * satisfy that heuristic and be misclassified `html` despite containing zero
 * real elements, which is precisely the failure mode this backfill exists to
 * catch. It remains correct for its own callers (content-format detection
 * for diffing and version snapshotting across html/json/tiptap/text), where
 * being wrong about markdown-vs-text has no data-loss consequence. This
 * classifier instead parses the content with the same DOM the collab content
 * census used to measure the 3,003-page population (`hasRealHtmlElement`
 * above), because that is the only method proven against production data.
 *
 * A parse failure classifies as `{ confident: false }` rather than guessing a
 * format — per-page callers must skip and report these, not act on them.
 */
export function classifyDocumentContent(content: string, workspace: DomWorkspace): ClassifyContentResult {
  if (!/\S/.test(content)) {
    return { format: 'empty', confident: true };
  }

  try {
    const container = workspace.parse(content);
    return hasRealHtmlElement(container)
      ? { format: 'html', confident: true }
      : { format: 'markdown-source', confident: true };
  } catch (error) {
    return {
      format: 'unknown',
      confident: false,
      reason: error instanceof Error ? error.name : 'unknown',
    };
  }
}
