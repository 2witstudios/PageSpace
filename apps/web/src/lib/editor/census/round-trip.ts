import type { Extensions } from '@tiptap/core';
import { generateHTML, generateJSON } from '@tiptap/html/server';
import { droppedConstructs, type ConstructScanner } from './constructs';

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
 * Runs one stored document through HTML -> ProseMirror -> HTML against the live
 * editor schema and reports what did not survive.
 *
 * `@tiptap/html/server` rather than the browser build: it drives happy-dom
 * internally, which is the DOM `@tiptap/html@3` declares as its peer, so this
 * needs no global DOM shim and no headless browser.
 */
export function analyzeHtmlDocument(
  html: string,
  extensions: Extensions,
  scanner: ConstructScanner,
): HtmlDocumentAnalysis {
  try {
    // An empty document has nothing to lose. Round-tripping it would compare
    // '' against TipTap's `<p></p>` and report every empty page as changed.
    if (html.trim() === '') {
      return { status: 'analysed', dropped: [], textPreserved: true };
    }

    const source = scanner.scan(html);
    const output = scanner.scan(generateHTML(generateJSON(html, extensions), extensions));

    return {
      status: 'analysed',
      dropped: droppedConstructs(source, output),
      textPreserved: output.text === source.text,
    };
  } catch (error) {
    return {
      status: 'failed',
      errorName: error instanceof Error ? error.name : 'unknown',
    };
  }
}
