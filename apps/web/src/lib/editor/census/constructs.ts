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
  /**
   * The document's visible text, whitespace-collapsed, for comparing a document
   * against its own round trip. It never leaves the process: only the boolean
   * "was any text lost" reaches the report.
   */
  text: string;
}

export interface ConstructScanner {
  scan(html: string): DocumentConstructs;
  close(): void;
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
 * Whitespace is not content: TipTap re-indents its output, so comparing raw
 * text would report every document as changed for the same reason comparing
 * raw markup does. Non-breaking spaces collapse too — a `&nbsp;` that comes
 * back as a plain space has not lost anything a reader would miss.
 */
function normalizeText(text: string): string {
  return text.replace(/[\s\u00a0]+/g, ' ').trim();
}

/**
 * One happy-dom `Window` reused across every document in the run. The census
 * streams tens of thousands of pages and parses each one twice (source and
 * round trip); a window per parse is the difference between a scan and an
 * afternoon. Each scan parses into a fresh detached element, so nothing leaks
 * between documents.
 *
 * happy-dom rather than jsdom or zeed-dom: it is the DOM `@tiptap/html@3`
 * declares as its peer, so the census parses HTML with the same implementation
 * the round trip serializes it with.
 */
export function createConstructScanner(): ConstructScanner {
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
    scan(html: string): DocumentConstructs {
      const elements = new Set<string>();
      const attributesByElement = new Map<string, Set<string>>();
      const container = window.document.createElement('div');
      container.innerHTML = html;

      for (const element of container.querySelectorAll('*')) {
        const tag = element.tagName.toLowerCase();
        elements.add(tag);

        let attributes = attributesByElement.get(tag);
        for (const name of element.getAttributeNames()) {
          const value = element.getAttribute(name) ?? '';
          for (const key of attributeKeys(name.toLowerCase(), value)) {
            if (!attributes) {
              attributes = new Set<string>();
              attributesByElement.set(tag, attributes);
            }
            attributes.add(key);
          }
        }
      }

      return { elements, attributesByElement, text: normalizeText(container.textContent) };
    },

    close(): void {
      void window.happyDOM.abort();
      void window.happyDOM.close();
    },
  };
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
