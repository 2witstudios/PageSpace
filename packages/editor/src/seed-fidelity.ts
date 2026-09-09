import { HTML_ELEMENT_NAMES, UNESCAPED_ANGLE_BRACKET_KEY } from './html-element-names.js';

/**
 * The seed-fidelity vocabulary: markup constructs as comparable keys, and the
 * one allowlist of rewrites a pass through the frozen schema is permitted to
 * make.
 *
 * Shared by `__tests__/seed-fidelity.test.ts` (the construct corpus) and
 * `scripts/collab-seed-audit.ts` (real documents) on purpose. The bar is
 * `render(parse(h1)) == h1` — a FIXPOINT — plus zero loss of any
 * content-bearing construct; it is deliberately NOT byte-identical output.
 * Measured over the corpus, one pass through the schema rewrites its input in
 * ways that lose nothing: tables gain `<colgroup>` and `min-width`, a bare
 * `<ul>` gains `class="tight" data-tight="true"`, bare `<li>` text is wrapped
 * in `<p>`, `TaskItem` renders its own checkbox markup, `Link` stamps
 * `target`/`rel`. A byte-equality assertion would fail on all of that and
 * send its next reader off to "fix" normalisation that is not broken.
 *
 * The danger in relaxing an assertion is that the relaxation swallows a real
 * loss. So the tolerance is NOT a loose comparison — it is this explicit,
 * exhaustively-named allowlist, which the corpus test also asserts is not
 * larger than it needs to be. Keeping one copy is what stops the audit and
 * the test from tolerating different things.
 */

/**
 * Every markup construct one pass through the schema is allowed to ADD.
 *
 * Each entry is a rewrite whose absence from the source is not information:
 *
 * - `a@target` / `a@rel` — `Link` stamps these on every anchor it renders.
 * - `a@data-type`, `span@data-type` — TipTap's node-name marker on a mention.
 * - `a@contenteditable`, `a@data-drive-id` — the AI mention dialect omits
 *   them; the node's own `renderHTML` always writes them.
 * - `ul@class`, `ul@data-tight`, `ol@class`, `ol@data-tight` (`=true`) —
 *   `MarkdownTightLists` makes the tightness it INFERRED from the source
 *   (`!element.querySelector('p')`) explicit, on both list kinds.
 * - `a@data-drive-id=` — the AI mention dialect carries no drive, and the
 *   node's `renderHTML` always writes the attribute, so it appears empty. The
 *   EMPTY value is the allowlisted one; a mention gaining a real drive id would
 *   produce a different key and fail.
 * - `p` — a bare `<li>text</li>` becomes `<li><p>text</p></li>`, because the
 *   schema's `listItem` content is `paragraph block*`.
 * - `label`, `input`, `input@type`, `input@checked`, `span`, `div` —
 *   `TaskItem`'s rendered checkbox. The state itself lives in
 *   `li@data-checked`, which the source already carried.
 * - `pre@class` — `CodeBlockNode` mirrors `language-x` onto the `<pre>`.
 * - `table@style`, `colgroup`, `col`, `col@style` (and their `style:min-width`
 *   forms) — TipTap's table column model, emitted as `min-width` from the
 *   schema's own defaults.
 * - `td@colspan`, `td@rowspan`, `th@colspan`, `th@rowspan` (`=1`) — every
 *   cell is rendered with its span made explicit. The VALUE `1` is the
 *   allowlisted one: a cell whose span actually changed produces a different
 *   key and fails.
 *
 * The `=pageMention` entries are the VALUE-bearing form of the `data-type`
 * marker above. They are listed separately, and deliberately: it is the value
 * that carries the meaning, so `data-type` changing from `taskList` to
 * `taskItem` must fail rather than be absorbed by a bare `attr@data-type`.
 *
 * Nothing here changes what the document SAYS. An addition outside this set is
 * a change to the stored dialect and must be looked at, not tolerated.
 */
export const ALLOWED_COSMETIC_ADDITIONS: ReadonlySet<string> = new Set([
  'attr:a@contenteditable',
  'attr:a@data-drive-id',
  'attr:a@data-drive-id=',
  'attr:a@data-type',
  'attr:a@data-type=pageMention',
  'attr:a@rel',
  'attr:a@target',
  'attr:col@style',
  'attr:col@style:min-width',
  'attr:input@checked',
  'attr:input@type',
  'attr:ol@class',
  'attr:ol@data-tight',
  'attr:ol@data-tight=true',
  'attr:pre@class',
  'attr:span@data-type',
  'attr:span@data-type=pageMention',
  'attr:table@style',
  'attr:table@style:min-width',
  'attr:td@colspan',
  'attr:td@colspan=1',
  'attr:td@rowspan',
  'attr:td@rowspan=1',
  'attr:th@colspan',
  'attr:th@colspan=1',
  'attr:th@rowspan',
  'attr:th@rowspan=1',
  'attr:ul@class',
  'attr:ul@data-tight',
  'attr:ul@data-tight=true',
  'el:col',
  'el:colgroup',
  'el:div',
  'el:input',
  'el:label',
  'el:p',
  'el:span',
]);

/**
 * Attributes whose VALUE is the construct, not just their presence.
 *
 * `text-align:center` becoming `text-align:left`, `data-type="taskList"`
 * becoming `taskItem`, a rewritten `href`, a `data-page-id` pointing at a
 * different page, or `start="7"` becoming `start="1"` would all be invisible
 * to a comparison whose entire job is naming the construct that moved.
 */
export const VALUE_BEARING_ATTRIBUTES: ReadonlySet<string> = new Set([
  'data-type',
  'href',
  'data-page-id',
  'data-user-id',
  'data-role-id',
  'data-drive-id',
  'data-file-id',
  'data-block-id',
  'data-change-id',
  'data-change-type',
  'data-checked',
  'data-tight',
  'start',
  'colspan',
  'rowspan',
  'alt',
]);

/**
 * The subset of `VALUE_BEARING_ATTRIBUTES` whose values may be PRINTED, each
 * with the validator its value must pass first. These are the schema's own
 * enumerations and small integers; a value that fails its validator is
 * user-typed (`data-type="customer-name"`) and is folded to presence.
 * Everything else on the value-bearing list — `href`, `alt`, the `data-*-id`
 * family — is user content or an identifier and is never printed. Declared
 * beside the list it partitions so adding a value-bearing attribute forces the
 * printability decision in the same diff.
 */
export const PRINTABLE_ATTRIBUTE_VALUES: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ['data-type', (value: string) => SCHEMA_DATA_TYPES.has(value)],
  ['data-checked', (value: string) => value === 'true' || value === 'false'],
  ['data-tight', (value: string) => value === 'true' || value === 'false'],
  ['start', (value: string) => /^\d{1,6}$/u.test(value)],
  ['colspan', (value: string) => /^\d{1,6}$/u.test(value)],
  ['rowspan', (value: string) => /^\d{1,6}$/u.test(value)],
]);

/** Every `data-type` value a node in the frozen schema renders. */
export const SCHEMA_DATA_TYPES: ReadonlySet<string> = new Set(['taskList', 'taskItem', 'pageMention']);

/**
 * The NAMES the report may print — closed lists, not a shape. A parser turns
 * `Set<string>` in prose into a `<string>` element and `<p note=...>` into an
 * attribute, so a name is as much under the author's control as a value is,
 * and any lower-case token would print `secretattr`. Tags must be real HTML
 * (`HTML_ELEMENT_NAMES`); attributes and CSS properties must be ones the
 * frozen schema reads or writes, or common HTML the census has already
 * reported on. The corpus test asserts every attribute and property the
 * corpus produces is on these lists, so they cannot go stale silently.
 */
export const KNOWN_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  'alt', 'checked', 'class', 'colspan', 'contenteditable', 'dir', 'height', 'href', 'id', 'lang',
  'rel', 'rowspan', 'spellcheck', 'src', 'start', 'style', 'target', 'title', 'type', 'width',
  'data-author-id', 'data-block-id', 'data-change-id', 'data-change-type', 'data-checked',
  'data-drive-id', 'data-file-id', 'data-label', 'data-language', 'data-mention-type',
  'data-page-id', 'data-role-id', 'data-thread-id', 'data-tight', 'data-type', 'data-user-id',
  'data-width',
]);

export const KNOWN_STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  'background-color', 'color', 'font-family', 'font-size', 'font-style', 'font-weight',
  'line-height', 'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top',
  'min-width', 'padding', 'text-align', 'text-decoration', 'width',
]);

const UNRECOGNISED_ATTRIBUTE = '(unrecognised-attribute)';
const UNRECOGNISED_PROPERTY = '(unrecognised-property)';
/** Stands in for an attribute value that is the author's text rather than the schema's. */
const WITHHELD_VALUE = '(withheld)';

/**
 * A construct key with everything the author could have typed removed:
 * unknown tag names become `UNESCAPED_ANGLE_BRACKET_KEY` (the census's own
 * marker for the same artefact), attribute and property names outside the
 * known lists are folded to a fixed placeholder, and a value survives only if
 * its attribute is in `PRINTABLE_ATTRIBUTE_VALUES` AND the value passes that
 * validator.
 *
 * The COMPARISON must run on the raw form (`ALLOWED_COSMETIC_ADDITIONS`
 * names `attr:a@data-drive-id=` and the `=1`/`=true` forms); only what is
 * REPORTED from real documents goes through here.
 */
export function contentFreeKey(key: string): string {
  const element = /^el:(.+)$/u.exec(key);
  if (element) {
    return HTML_ELEMENT_NAMES.has(element[1]) ? key : UNESCAPED_ANGLE_BRACKET_KEY;
  }
  const attribute = /^attr:([^@]+)@([^=]+)(?:=(.*))?$/su.exec(key);
  // FAIL CLOSED. A key this cannot decompose is not a key this can vouch for,
  // and handing back the input is how a sanitiser leaks. It is reachable, not
  // theoretical: happy-dom builds a real element for a tag name starting with
  // `@` — a pasted FreeMarker directive (`<@list items="payroll.csv">`) or a
  // Slack mention (`<@U08JANE.DOE email="...">`) — and the tag group above
  // needs one non-`@` character, so those keys fall straight through. They
  // came from an unescaped `<` in prose, which is exactly what the marker is
  // for. It also makes folding idempotent for free: the marker itself is not
  // an `el:`/`attr:` key, so re-folding one returns it unchanged. A separate
  // guard for that was measurably dead — removing it changed no test.
  if (!attribute) return UNESCAPED_ANGLE_BRACKET_KEY;
  const [, tag, rawName, value] = attribute;
  if (!HTML_ELEMENT_NAMES.has(tag)) return UNESCAPED_ANGLE_BRACKET_KEY;

  const style = /^style:(.*)$/su.exec(rawName);
  if (style) {
    const property = KNOWN_STYLE_PROPERTIES.has(style[1]) ? style[1] : UNRECOGNISED_PROPERTY;
    return `attr:${tag}@style:${property}`;
  }
  const name = KNOWN_ATTRIBUTE_NAMES.has(rawName) ? rawName : UNRECOGNISED_ATTRIBUTE;
  if (value === undefined) return `attr:${tag}@${name}`;
  const printable = PRINTABLE_ATTRIBUTE_VALUES.get(name);
  // A withheld value keeps the `=` marker. `constructKeysOf` emits the
  // presence key and the value key side by side so that an attribute the
  // schema DROPPED and one whose value it CHANGED stay distinguishable;
  // folding a withheld value down to the bare presence key would collapse
  // that distinction at the last step, and would also let a key outside
  // `ALLOWED_COSMETIC_ADDITIONS` print as one that is on it.
  return printable?.(value) ? `attr:${tag}@${name}=${value}` : `attr:${tag}@${name}=${WITHHELD_VALUE}`;
}

/**
 * The markup under `root` as comparable keys: `el:<tag>`,
 * `attr:<tag>@<name>`, `attr:<tag>@<name>=<value>` for the value-bearing
 * attributes, and `attr:<tag>@style:<property>` per inline CSS property.
 *
 * Deliberately not the markup string: a set difference names WHICH construct
 * moved, where a string diff only says "changed". Presence-only keys are kept
 * alongside the value keys, so a DROPPED attribute and a CHANGED one are
 * distinguishable in the diff. `style` is split per property because a bare
 * `attr:p@style` merges the question with the answer.
 *
 * Structural, not lexical — but NOT content-free: the value-bearing keys carry
 * `href`, `alt` and the id attributes verbatim, because a rewritten href or a
 * changed alt is exactly what the corpus test has to see. `alt` is prose. A
 * consumer that PRINTS keys from real documents (`scripts/collab-seed-audit.ts`)
 * folds every value except the schema's own enumerations back to the presence
 * form before tallying; see `contentFreeKey` below.
 */
export function constructKeysOf(root: Element): Set<string> {
  const keys = new Set<string>();
  /** Depth-first over the element tree, adding every construct each element carries. */
  const walk = (element: Element): void => {
    const tag = element.tagName.toLowerCase();
    keys.add(`el:${tag}`);
    for (const name of element.getAttributeNames()) {
      keys.add(`attr:${tag}@${name}`);
      if (VALUE_BEARING_ATTRIBUTES.has(name)) {
        keys.add(`attr:${tag}@${name}=${element.getAttribute(name) ?? ''}`);
      }
      if (name === 'style') {
        for (const declaration of (element.getAttribute(name) ?? '').split(';')) {
          const property = declaration.split(':')[0]?.trim().toLowerCase();
          if (property) {
            keys.add(`attr:${tag}@style:${property}`);
          }
        }
      }
    }
    for (const child of Array.from(element.children)) {
      walk(child);
    }
  };
  for (const child of Array.from(root.children)) {
    walk(child);
  }
  return keys;
}

/** Keys in `a` that `b` lacks, sorted — the "what moved" half of every comparison here. */
export function constructDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((key) => !b.has(key)).sort();
}
