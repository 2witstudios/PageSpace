import type { Schema } from '@tiptap/pm/model';
import { DOMParser as ProseMirrorDOMParser, DOMSerializer } from '@tiptap/pm/model';
import { projectContent } from '@pagespace/lib/content/anchoring/text-projection';
import { collectConstructs, droppedConstructs, hasHtmlElement, type DomWorkspace } from './constructs';
import { htmlImageSources, type ImageSource } from './images';
import { emptyMagnitudes, htmlMagnitudes, type Magnitudes } from './magnitudes';

export type HtmlDocumentAnalysis =
  | {
      status: 'analysed';
      /** Construct keys the round trip lost. Never content. */
      dropped: string[];
      /**
       * Whether every character of visible text survived. Deliberately NOT
       * "is the markup identical": the Link extension stamps
       * `target`/`rel` onto every `<a>` it parses, so byte comparison calls
       * ~every document with a link changed and drowns the signal it is here
       * to carry — that the schema lost something the census does not name.
       */
      textPreserved: boolean;
      /**
       * The stored document parsed to no HTML element at all — markdown source
       * filed under `contentMode='html'`. The census routes these through the
       * markdown detector as well, because the HTML scan is blind to every
       * construct they contain.
       */
      tagless: boolean;
      /** Scheme buckets and bare hostnames — never a URL. See `images.ts`. */
      images: ImageSource[];
      magnitudes: Magnitudes;
    }
  | {
      /**
       * The document could not be round-tripped at all. Only the error TYPE is
       * kept: ProseMirror's parse errors quote the offending markup, and this
       * census runs against production user data.
       */
      status: 'failed';
      errorName: string;
    };

/**
 * One stored document through HTML -> ProseMirror -> HTML against the live
 * editor schema, returned as markup.
 *
 * This is what `@tiptap/html`'s `generateJSON` + `generateHTML` do, minus the
 * per-call schema build, the two throwaway windows and the JSON hop the census
 * never reads — see `DomWorkspace`. Exported so the test can hold it against
 * the wrapper's own output.
 */
export function roundTripHtml(html: string, schema: Schema, workspace: DomWorkspace): string {
  return roundTrip(workspace.parse(html), schema, workspace).innerHTML;
}

function roundTrip(source: ReturnType<DomWorkspace['parse']>, schema: Schema, workspace: DomWorkspace) {
  const parsed = ProseMirrorDOMParser.fromSchema(schema).parse(source as unknown as Node);
  const output = workspace.empty();
  DOMSerializer.fromSchema(schema).serializeFragment(
    parsed.content,
    { document: workspace.document },
    output as unknown as HTMLElement,
  );
  return output;
}

export function analyzeHtmlDocument(
  html: string,
  schema: Schema,
  workspace: DomWorkspace,
): HtmlDocumentAnalysis {
  try {
    // Defence for callers other than the CLI, which routes empty content to the
    // `empty` tally before it gets here. Round-tripping '' would compare it
    // against TipTap's `<p></p>` and report every empty page as changed.
    if (!/\S/.test(html)) {
      return {
        status: 'analysed',
        dropped: [],
        textPreserved: true,
        tagless: false,
        images: [],
        magnitudes: emptyMagnitudes(),
      };
    }

    const source = workspace.parse(html);
    const constructs = collectConstructs(source);
    const output = roundTrip(source, schema, workspace);

    return {
      status: 'analysed',
      dropped: droppedConstructs(constructs, collectConstructs(output)),
      tagless: !hasHtmlElement(constructs),
      images: htmlImageSources(source),
      magnitudes: htmlMagnitudes(source),
      // projectContent is the repo's shared page-text flattener: it ends a run
      // of text at every block boundary and drops <script>/<style> bodies.
      // Element.textContent does neither, so two paragraphs merging into one
      // would read as "no text lost" — exactly the loss this signal exists to
      // catch.
      textPreserved: projectContent(output.innerHTML, 'html') === projectContent(html, 'html'),
    };
  } catch (error) {
    return {
      status: 'failed',
      errorName: error instanceof Error ? error.name : 'unknown',
    };
  }
}
