import { DOMParser as PmDOMParser, type Node as PmNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { collabSchema, pmDocToYDoc } from './collab-document.js';
import { withDomWorkspace, type DomWorkspace } from './dom-workspace.js';
import { pmDocToText } from './y-doc-to-text.js';
import { UnrepresentableContentError } from './projection-errors.js';

/**
 * Elements whose content is not text, mapped to the schema node that must
 * absorb them. `null` means the frozen v1 schema has no node for this element
 * at all, so its presence is always a loss.
 *
 * A text-only comparison is blind to every one of these: an `<img>` with no
 * `data-file-id` (which `ImageNode` deliberately refuses — there is no URL to
 * `fileId` pipeline yet) carries no characters, so dropping it changes no
 * text. Losing a picture is not a cosmetic difference.
 *
 * `<br>` is deliberately absent. ProseMirror legitimately discards a trailing
 * `<br>` at the end of a block — browsers emit those as caret padding, not as
 * content — so counting them reports a loss on markup that lost nothing.
 */
const TEXTLESS_CONTENT_ELEMENTS: Readonly<Record<string, string | null>> = {
  img: 'image',
  hr: 'horizontalRule',
  iframe: null,
  video: null,
  audio: null,
  embed: null,
  object: null,
  canvas: null,
  svg: null,
};

/**
 * Elements the parse is *supposed* to discard: they carry no document
 * content, and their text is not prose. Removed from the source before the
 * text comparison, or a `<style>` block's CSS reads as lost text.
 */
const NON_CONTENT_ELEMENTS = ['script', 'style', 'noscript', 'template'];

/**
 * Whitespace is stripped, not normalised, before comparing text.
 *
 * HTML collapses runs of whitespace and ProseMirror re-lays it out; a
 * whitespace difference is exactly the class of cosmetic rewrite the seed
 * invariant explicitly tolerates. What must not change is the sequence of
 * visible characters.
 */
function visibleCharacters(text: string): string {
  return text.replace(/\s+/gu, '');
}

function countNodesOfType(doc: PmNode, typeName: string): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === typeName) {
      count += 1;
    }
    return true;
  });
  return count;
}

/**
 * What parsing `html` against the frozen schema would lose — an empty array
 * when nothing is lost.
 *
 * Exported so a bulk seed can survey a corpus and route the exceptions,
 * rather than catching `UnrepresentableContentError` a page at a time. The
 * reasons are counts and element names; the offending markup is never
 * included, because this runs over production user content.
 */
export function describeHtmlLoss(html: string): string[] {
  return withDomWorkspace((workspace) => parseAndDiagnose(html, workspace).reasons);
}

/**
 * One parse, both answers. `htmlToPmDoc` needs the document *and* the verdict
 * on it, and parsing twice to get them would double the cost of every seed —
 * and, worse, leave open the possibility of the checked document and the
 * returned one differing.
 */
function parseAndDiagnose(
  html: string,
  workspace: DomWorkspace,
): { doc: PmNode; reasons: string[] } {
  const source = workspace.parse(html);
  for (const tag of NON_CONTENT_ELEMENTS) {
    for (const element of Array.from(source.querySelectorAll(tag))) {
      element.remove();
    }
  }

  const doc = parseHtmlElementUnchecked(source);
  const reasons: string[] = [];

  const sourceText = visibleCharacters(source.textContent ?? '');
  const parsedText = visibleCharacters(pmDocToText(doc));
  if (sourceText !== parsedText) {
    // Counts only. Quoting the differing text would put user prose into an
    // error message, a log line and a Sentry event.
    reasons.push(
      `visible text changed (${sourceText.length} characters in, ${parsedText.length} out)`,
    );
  }

  for (const [tag, nodeName] of Object.entries(TEXTLESS_CONTENT_ELEMENTS)) {
    const inSource = Array.from(source.querySelectorAll(tag)).length;
    if (inSource === 0) {
      continue;
    }
    const survived = nodeName === null ? 0 : countNodesOfType(doc, nodeName);
    if (survived < inSource) {
      reasons.push(`dropped ${inSource - survived} <${tag}> element(s)`);
    }
  }

  return { doc, reasons };
}

/**
 * The parse itself, with NO loss check — the one step `htmlToPmDoc` wraps.
 *
 * Exported for surveys only: `scripts/collab-seed-audit.ts` needs the
 * document a lossy page parses TO, so it can name what was lost, and
 * `htmlToPmDoc` throws on exactly those pages. Nothing that seeds may call
 * this; the gate is `htmlToPmDoc`/`htmlToYDoc`, and bypassing it is how a
 * lossy document becomes permanent.
 *
 * `preserveWhitespace: 'full'` is deliberately NOT passed. The schema's own
 * `codeBlock` carries `whitespace: 'pre'`, so ProseMirror already preserves
 * whitespace exactly where it is significant; forcing it document-wide would
 * turn every indentation newline in stored, pretty-printed HTML into document
 * text.
 *
 * `DOMParser.parse` reads the element it is given and never reaches for a
 * global `document`, which is what lets this run in a Node service with no DOM
 * installed process-wide.
 */
export function parseHtmlElementUnchecked(source: HTMLElement): PmNode {
  return PmDOMParser.fromSchema(collabSchema()).parse(source);
}

/**
 * Stored `pages.content` HTML, parsed to a ProseMirror document over the
 * frozen v1 schema. **Throws** rather than return a document that lost
 * content — see `UnrepresentableContentError`.
 *
 * The invariant this upholds is `render(parse(h1)) == h1`, NOT
 * `parse(h1) == h1` byte-for-byte. Measured over the construct corpus, one
 * pass through the schema is a *fixpoint* that nonetheless rewrites its
 * input: tables gain `<colgroup>`, `min-width` and explicit `colspan="1"`;
 * a bare `<ul>` gains `class="tight" data-tight="true"`; bare `<li>` text
 * gets wrapped in `<p>`; `style` declarations reorder and requote. None of
 * that is loss, and a byte-equality test here would send its next reader off
 * to "fix" normalisation that is not broken. The allowlist of those rewrites
 * is explicit in `__tests__/seed-fidelity.test.ts` rather than expressed as a
 * tolerance, so a real loss cannot be rounded away by a loose comparison.
 */
export function htmlToPmDoc(html: string): PmNode {
  return withDomWorkspace((workspace) => {
    const { doc, reasons } = parseAndDiagnose(html, workspace);
    if (reasons.length > 0) {
      throw new UnrepresentableContentError(reasons);
    }
    return doc;
  });
}

/**
 * Stored HTML seeded into a fresh `Y.Doc` — the inbound half of the
 * conversion core, and the only supported way a document enters the CRDT.
 *
 * SEEDING ONLY: this builds a *new* `Y.Doc`. Applying a server-computed
 * document to one that already has collaborators is `applyPmDocToYDoc`,
 * which diffs; seeding replaces.
 */
export function htmlToYDoc(html: string): Y.Doc {
  return pmDocToYDoc(htmlToPmDoc(html));
}
