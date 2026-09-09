/**
 * The construct corpus — one named fixture per content-bearing construct the
 * frozen v1 schema can represent.
 *
 * Three different invariants are held against this same list on purpose:
 * seed fidelity (`seed-fidelity.test.ts`), projection fidelity
 * (`projections.test.ts`) and cross-DOM parse equality
 * (`cross-dom-parse-equality.test.ts`). Sharing the corpus is what makes
 * "covered by one, silently missing from another" impossible — adding a
 * construct here adds it to all three at once, and each of those suites
 * asserts it covers every entry rather than iterating whatever it is given.
 *
 * Fixtures are written in the dialect the schema RENDERS (`<li><p>text</p>`,
 * explicit `colspan`), except where the fixture's whole point is a foreign
 * dialect — `bareList`, `bareListItem` and the three legacy/AI mention
 * dialects. That keeps the fixpoint assertion meaningful for the normalised
 * cases and still exercises the parser's tolerance for stored content.
 */
export interface ConstructFixture {
  /** Stable key; the suites assert they covered every one of these. */
  readonly key: string;
  readonly html: string;
  /**
   * Visible prose the text projection MUST contain. Never markup — a fixture
   * whose expectation named a tag would defeat the projection it is checking.
   */
  readonly text: readonly string[];
}

export const CONSTRUCT_CORPUS: readonly ConstructFixture[] = [
  {
    key: 'headings-1-to-6',
    html:
      '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>',
    text: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'],
  },
  {
    key: 'paragraph-with-hard-break',
    html: '<p>first line<br>second line</p>',
    text: ['first line', 'second line'],
  },
  {
    key: 'all-marks',
    html:
      '<p><strong>bold</strong> <em>italic</em> <s>strike</s> <u>under</u> ' +
      '<code>code</code> <mark>highlighted</mark> ' +
      '<a href="https://example.test/a">linked</a></p>',
    text: ['bold', 'italic', 'strike', 'under', 'code', 'highlighted', 'linked'],
  },
  {
    key: 'collab-marks',
    html:
      '<p><span data-thread-id="th_1">commented</span> ' +
      '<span data-change-type="insertion" data-author-id="u1" data-change-id="c1">added</span> ' +
      '<span data-change-type="deletion" data-author-id="u1" data-change-id="c2">removed</span></p>',
    text: ['commented', 'added', 'removed'],
  },
  {
    key: 'text-style-span',
    // The `<span style>` shape `TextStyleKit` owns since `FontFormatting` was
    // deleted. Its `parseHTML` reads the DOM's *parsed* style declaration, not
    // the source string, which is exactly why cross-DOM equality is asserted.
    html:
      '<p><span style="font-family: \'Times New Roman\'; font-size: 14px; color: #ff0000">tinted</span></p>',
    text: ['tinted'],
  },
  {
    key: 'text-align',
    html: '<p style="text-align: center">centred</p><h2 style="text-align: right">right</h2>',
    text: ['centred', 'right'],
  },
  {
    key: 'loose-list',
    html: '<ul><li><p>alpha</p></li><li><p>beta</p></li></ul>',
    text: ['alpha', 'beta'],
  },
  {
    key: 'bare-list',
    // No `<p>` inside the items, so `MarkdownTightLists` parses `tight: true`
    // (`!element.querySelector('p')`) — the tight/loose distinction, read from
    // the DOM rather than the source string.
    html: '<ul><li>alpha</li><li>beta</li></ul>',
    text: ['alpha', 'beta'],
  },
  {
    key: 'nested-list',
    html:
      '<ul><li><p>outer</p><ul><li><p>inner</p><ol><li><p>deep</p></li></ol></li></ul></li></ul>',
    text: ['outer', 'inner', 'deep'],
  },
  {
    key: 'bare-ordered-list',
    // The `<ol>` twin of `bare-list`: `MarkdownTightLists` infers and then
    // writes `tight` on ordered lists too.
    html: '<ol><li>first</li><li>second</li></ol>',
    text: ['first', 'second'],
  },
  {
    key: 'ordered-list-with-start',
    html: '<ol start="7"><li><p>seven</p></li><li><p>eight</p></li></ol>',
    text: ['seven', 'eight'],
  },
  {
    key: 'task-list',
    html:
      '<ul data-type="taskList">' +
      '<li data-type="taskItem" data-checked="true"><p>done</p></li>' +
      '<li data-type="taskItem" data-checked="false"><p>pending</p></li>' +
      '</ul>',
    text: ['done', 'pending'],
  },
  {
    key: 'blockquote',
    html: '<blockquote><p>quoted prose</p></blockquote>',
    text: ['quoted prose'],
  },
  {
    key: 'code-block-with-language',
    html: '<pre><code class="language-typescript">const answer = 42;</code></pre>',
    text: ['const answer = 42;'],
  },
  {
    key: 'code-block-without-language',
    html: '<pre><code>plain code</code></pre>',
    text: ['plain code'],
  },
  {
    key: 'horizontal-rule',
    html: '<p>above</p><hr><p>below</p>',
    text: ['above', 'below'],
  },
  {
    key: 'table',
    html:
      '<table><tbody>' +
      '<tr><th colspan="1" rowspan="1"><p>Name</p></th><th colspan="1" rowspan="1"><p>Role</p></th></tr>' +
      '<tr><td colspan="1" rowspan="1"><p>Ada</p></td><td colspan="1" rowspan="1"><p>Engineer</p></td></tr>' +
      '</tbody></table>',
    text: ['Name', 'Role', 'Ada', 'Engineer'],
  },
  {
    key: 'bare-table',
    // No `<tbody>`, no `colspan`/`rowspan`, bare cell text: the dialect a
    // hand-written or imported table arrives in. The schema fills in every
    // one of those (`colspan="1"`, `rowspan="1"`, `<p>` per cell), which is
    // what earns those entries their place on the cosmetic allowlist.
    html: '<table><tr><th>Name</th><th>Role</th></tr><tr><td>Ada</td><td>Engineer</td></tr></table>',
    text: ['Name', 'Role', 'Ada', 'Engineer'],
  },
  {
    key: 'image-with-file-id',
    html: '<img data-file-id="file_abc123" alt="a diagram" data-width="320">',
    text: [],
  },
  {
    key: 'block-id-and-change-attrs',
    html:
      '<p data-block-id="blk_1" data-change-id="chg_1" data-change-type="insertion">tracked</p>',
    text: ['tracked'],
  },
  {
    key: 'mention-page',
    html:
      '<p><a class="mention" contenteditable="false" href="/dashboard/drv_1/pg_1" ' +
      'rel="noopener noreferrer nofollow" data-mention-type="page" data-page-id="pg_1" ' +
      'data-drive-id="drv_1">@Design Notes</a></p>',
    text: ['@Design Notes'],
  },
  {
    key: 'mention-user',
    html:
      '<p><a class="mention" contenteditable="false" data-mention-type="user" ' +
      'data-user-id="usr_1" data-drive-id="drv_1">@Ada</a></p>',
    text: ['@Ada'],
  },
  {
    key: 'mention-role',
    html:
      '<p><span class="mention" contenteditable="false" data-mention-type="role" ' +
      'data-role-id="rol_1" data-drive-id="drv_1">@Editors</span></p>',
    text: ['@Editors'],
  },
  {
    key: 'mention-everyone',
    html:
      '<p><span class="mention" contenteditable="false" data-mention-type="everyone" ' +
      'data-drive-id="drv_1">@everyone</span></p>',
    text: ['@everyone'],
  },
  {
    key: 'mention-ai-dialect',
    // What `lib/ai/skills/bodies/writing-documents.ts` instructs models to
    // write: no href, no label attribute, no `data-type`. The label falls back
    // to the element's text.
    html: '<p><a class="mention" data-mention-type="page" data-page-id="pg_2">@Roadmap</a></p>',
    text: ['@Roadmap'],
  },
] as const;

/**
 * The corpus as `it.each` rows. Exported because three suites parametrise over
 * it and each was writing this same `.map` inline — the kind of line that
 * drifts when one file adds a filter and the others do not.
 */
export const CORPUS_CASES = CONSTRUCT_CORPUS.map(
  (fixture) => [fixture.key, fixture] as const,
);

/** Every fixture concatenated — one document exercising the whole corpus. */
export function corpusDocumentHtml(): string {
  return CONSTRUCT_CORPUS.map((fixture) => fixture.html).join('');
}
