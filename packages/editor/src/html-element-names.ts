/**
 * Real HTML element names. Anything outside this set that a parser produced is
 * not markup the author wrote — it is an unescaped `<` in prose or a code
 * sample (`ActionResult<void>`, `Set<string>`, `<task-id>`), which every
 * happy-dom parse turns into an element of its own.
 *
 * Lives in this package because three consumers need the exact same "does
 * this contain real HTML" answer: the content census and the
 * mislabelled-content-mode backfill in `apps/web` (which re-export it from
 * `lib/editor/document-content-format.ts`), and the seed fidelity audit in
 * root `scripts/`, which cannot import `apps/web`. A tagless-page count
 * measured with a different definition is not the same count.
 */
export const HTML_ELEMENT_NAMES: ReadonlySet<string> = new Set<string>([
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
 * Whether `container` holds at least one element the author could have
 * written as HTML. A page that has none is markdown or plain text — whatever
 * its `contentMode` column says — and seeding it through the HTML path
 * flattens it into one paragraph, permanently.
 */
export function hasRealHtmlElement(container: Element): boolean {
  for (const element of Array.from(container.querySelectorAll('*'))) {
    if (HTML_ELEMENT_NAMES.has(element.tagName.toLowerCase())) return true;
  }
  return false;
}
