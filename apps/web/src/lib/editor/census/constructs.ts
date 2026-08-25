import { Window } from 'happy-dom';

/**
 * Every structural construct a stored HTML document contains, in a form that
 * can be set-differenced against the same document after a
 * HTML -> ProseMirror -> HTML round trip.
 *
 * Element names and attribute keys are kept apart on purpose: an attribute of
 * an element that the schema drops outright says nothing extra (an `<img>` the
 * schema cannot represent takes `src` and `alt` with it), so the diff in
 * `droppedConstructs` only considers attributes of elements that survived.
 */
export interface DocumentConstructs {
  /** Lower-cased tag names, e.g. `img`, `h5`, `figure`. */
  elements: Set<string>;
  /** Tag name -> attribute construct keys carried by that tag. */
  attributesByElement: Map<string, Set<string>>;
}

/**
 * The DOM the census parses into, serializes back out of, and walks — one
 * window for the whole run.
 *
 * happy-dom rather than jsdom or zeed-dom: it is the DOM `@tiptap/html@3`
 * declares as its peer, so the census works with the same implementation
 * TipTap's own server-side round trip uses. The census drives ProseMirror
 * directly instead of calling that wrapper, because `generateJSON`/
 * `generateHTML` rebuild the schema and stand up a fresh window on every call —
 * ~2.5ms per document of setup the census would pay tens of thousands of times.
 * `round-trip.test.ts` pins the two paths to the same output.
 */
export interface DomWorkspace {
  /** Parses stored markup into a detached element. */
  parse(html: string): DomElement;
  /** A detached element to serialize a round-tripped document into. */
  empty(): DomElement;
  /** The document ProseMirror's `DOMSerializer` creates its nodes from. */
  document: Document;
  close(): void;
}

/**
 * happy-dom's `Element` is structurally the DOM's, but its `Window` is not
 * `lib.dom`'s, so the two type universes do not meet. The census only ever
 * needs these members; naming them beats casting the whole tree to `any`.
 */
export interface DomElement {
  innerHTML: string;
  /**
   * Read by the magnitude measurements only, and never reported — what leaves
   * `magnitudes.ts` is a length, not the text it was measured from.
   */
  textContent: string;
  tagName: string;
  getAttributeNames(): string[];
  getAttribute(name: string): string | null;
  /** Recursive: measuring a table means asking it for its own rows. */
  querySelectorAll(selector: string): Iterable<DomElement>;
}

/**
 * Attributes whose VALUE is the construct rather than the attribute itself.
 * `data-type="taskList"` is the whole of TipTap's task-list markup — a bare
 * `attr:data-type` row would merge it with every other TipTap node that
 * round-trips fine.
 */
const VALUE_BEARING_ATTRIBUTES = new Set(['data-type']);

/**
 * Inline `style` is reported per CSS property (`style:text-align`), not as one
 * `attr:style`. `text-align` is a v1 schema candidate; `color` already has a
 * home in `textStyle`. Merging them would make the census unable to tell the
 * question apart from the answer.
 */
function styleProperties(styleAttribute: string): string[] {
  return styleAttribute
    .split(';')
    .map((declaration) => declaration.split(':')[0].trim().toLowerCase())
    .filter((property) => property.length > 0);
}

function attributeKeys(name: string, value: string): string[] {
  if (name === 'style') {
    return styleProperties(value).map((property) => `style:${property}`);
  }
  if (VALUE_BEARING_ATTRIBUTES.has(name)) {
    return [`attr:${name}=${value}`];
  }
  return [`attr:${name}`];
}

/**
 * One happy-dom `Window` reused across every document in the run. The census
 * streams tens of thousands of pages and handles each one twice (source and
 * round trip); a window per document is the difference between a scan and an
 * afternoon. Every parse gets a fresh detached element, so nothing leaks
 * between documents.
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

  const empty = (): DomElement => window.document.createElement('div') as unknown as DomElement;

  return {
    empty,
    parse(html: string): DomElement {
      const container = empty();
      container.innerHTML = html;
      return container;
    },
    document: window.document as unknown as Document,
    close(): void {
      // close() aborts the window's async tasks on its way out; abort() as well
      // would just be the older, narrower half of the same call.
      void window.happyDOM.close();
    },
  };
}

/**
 * Real HTML element names. Anything outside this set that the parser produced is
 * not markup the author wrote — it is an unescaped `<` in prose or a code
 * sample. Documents here are full of `ActionResult<void>`, `Set<string>` and
 * CLI placeholders like `<task-id>`, and happy-dom turns every one of them into
 * an element. Reported individually they produced ~200 phantom rows that buried
 * the real findings; the census is meant to answer "what must v1 represent",
 * and the answer is never `<actionresult<void>`.
 *
 * They are still counted, under one key, because the phenomenon is worth
 * knowing: it means stored HTML contains unescaped angle brackets.
 */
const HTML_ELEMENT_NAMES = new Set<string>([
  'a','abbr','address','area','article','aside','audio','b','base','bdi','bdo','blockquote','body',
  'br','button','canvas','caption','cite','code','col','colgroup','data','datalist','dd','del',
  'details','dfn','dialog','div','dl','dt','em','embed','fieldset','figcaption','figure','footer',
  'form','h1','h2','h3','h4','h5','h6','head','header','hgroup','hr','html','i','iframe','img',
  'input','ins','kbd','label','legend','li','link','main','map','mark','menu','meta','meter','nav',
  'noscript','object','ol','optgroup','option','output','p','param','picture','pre','progress','q',
  'rp','rt','ruby','s','samp','script','section','select','slot','small','source','span','strong',
  'style','sub','summary','sup','table','tbody','td','template','textarea','tfoot','th','thead',
  'time','title','tr','track','u','ul','var','video','wbr','svg','math',
]);

/** Single bucket for parser artefacts of unescaped `<` in text. */
export const UNESCAPED_ANGLE_BRACKET_KEY = 'text:unescaped-angle-bracket';

export function collectConstructs(container: DomElement): DocumentConstructs {
  const elements = new Set<string>();
  const attributesByElement = new Map<string, Set<string>>();

  for (const element of container.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    if (!HTML_ELEMENT_NAMES.has(tag)) {
      // Not markup — an unescaped `<` in prose or a code sample.
      elements.add(UNESCAPED_ANGLE_BRACKET_KEY);
      continue;
    }
    elements.add(tag);

    const names = element.getAttributeNames();
    if (names.length === 0) continue;

    const attributes = attributesByElement.get(tag) ?? new Set<string>();
    attributesByElement.set(tag, attributes);
    for (const name of names) {
      for (const key of attributeKeys(name.toLowerCase(), element.getAttribute(name) ?? '')) {
        attributes.add(key);
      }
    }
  }

  return { elements, attributesByElement };
}

/**
 * Whether a stored `contentMode='html'` document contains any HTML at all.
 *
 * A document that parses to no element is not HTML — it is markdown source
 * filed under the wrong content mode, and it is the population the first
 * production run found 3,003 of. Those pages carry images, headings and code
 * fences the HTML scan cannot see, so the census has to route them through the
 * markdown detector as well.
 *
 * `text:unescaped-angle-bracket` does not count as an element: it exists
 * precisely because the parser turned a `<` in prose into one, and prose with a
 * generic in it is exactly what a mislabelled markdown document looks like.
 */
export function hasHtmlElement(constructs: DocumentConstructs): boolean {
  for (const element of constructs.elements) {
    if (element !== UNESCAPED_ANGLE_BRACKET_KEY) return true;
  }
  return false;
}

/**
 * What the round trip lost, as construct keys — never as content.
 *
 * Presence-based, per document: a construct counts as dropped when the source
 * had it and the round trip has none of it. It cannot see an instance-level
 * loss (one `<h5>` of three flattened while the others survive), which cannot
 * happen with a schema-level drop and is the only thing this census is asked
 * about.
 */
export function droppedConstructs(source: DocumentConstructs, output: DocumentConstructs): string[] {
  const dropped = new Set<string>();

  for (const tag of source.elements) {
    if (!output.elements.has(tag)) {
      dropped.add(`<${tag}>`);
      continue;
    }

    const outputAttributes = output.attributesByElement.get(tag);
    for (const key of source.attributesByElement.get(tag) ?? []) {
      if (!outputAttributes?.has(key)) {
        dropped.add(key);
      }
    }
  }

  return [...dropped].sort();
}
