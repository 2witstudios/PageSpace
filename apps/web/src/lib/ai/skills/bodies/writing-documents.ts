/**
 * writing-documents skill body — code-shipped instructions for writing and
 * editing DOCUMENT and CODE pages. Loaded on demand via load_skill / the
 * /writing-documents chip; keep in sync with the page write tools and
 * editor serialization.
 */
export const WRITING_DOCUMENTS_SKILL_BODY = `# Writing Documents

How to write and edit DOCUMENT and CODE pages well, using \`read_page\`, \`replace_lines\`, \`insert_content\`, and \`create_page\`.

## Content model — know which of three formats you are editing

Every text page is one of:

- **DOCUMENT, html mode (the default)** — rich text stored as Tiptap HTML. The stored HTML has no newlines; line structure is synthesized for you (see below).
- **DOCUMENT, markdown mode** (\`contentMode: 'markdown'\`) — raw markdown text, stored and edited exactly as written, with natural line structure.
- **CODE** — raw plain-text source with syntax highlighting. Treated exactly like markdown mode for editing: no HTML processing, natural lines.

\`read_page\` and every edit-tool result report the page's \`type\` and \`contentMode\` — check them before writing, and match the page's format. Writing markdown syntax into an html-mode DOCUMENT (or HTML tags into a markdown/CODE page) produces literal garbage, not formatting.

### Choosing contentMode at create_page

\`create_page\` takes an optional \`contentMode: 'html' | 'markdown'\` for DOCUMENT pages; it defaults to \`html\`. This is a creation-time choice — pick deliberately:

- **html** (default): documents humans will edit in the rich editor; anything needing tables, mentions, syntax-highlighted code blocks, or inline font styling.
- **markdown**: markdown-native content — docs mirrored from repositories, agent-maintained notes, content where you want clean line-based markdown editing. The editor renders it as rich text but stores markdown.

Never try to "convert" a page by writing the other syntax into it; create a new page with the right mode instead.

## What read_page shows you

\`read_page\` returns content with each line prefixed \`N→\` (1-based), plus \`totalLines\`, and supports \`lineStart\`/\`lineEnd\` ranges.

For html-mode DOCUMENTs, the stored HTML is first normalized by an **additive-only** line-breaker: a newline is added after each opening block tag, before each closing block tag, and between adjacent block tags (\`p\`, \`h1\`–\`h6\`, \`ul\`/\`ol\`/\`li\`, \`table\`/\`tr\`/\`td\`/\`th\`/\`thead\`/\`tbody\`, \`blockquote\`, \`pre\`, \`div\`, and similar). No characters are ever removed or changed. So a paragraph reads as three lines:

\`\`\`
12→<p>
13→The paragraph text, with <strong>inline marks</strong> kept on the text line.
14→</p>
\`\`\`

**The line numbers you see are the exact lines \`replace_lines\` and \`insert_content\` operate on** — the edit tools normalize with the same function before splitting into lines. CODE and markdown-mode pages skip normalization entirely; their line numbers are the file's natural lines.

CHANNEL, TASK_LIST, and FILE pages return structured data (transcripts, tasks, file metadata) rather than editable text — they are not targets for these editing tools.

## The read → edit workflow

1. **Always read before writing.** Never edit from memory of an earlier read.
2. Make your edit with \`replace_lines\` or \`insert_content\`.
3. **Line numbers shift after every edit.** An insert or a replacement with a different line count renumbers everything below it. Re-read the page (a \`lineStart\`/\`lineEnd\` range around the edit area is enough) before any further line-based edit. The edit result's \`newContent\` and \`newLineCount\` can also tell you the new layout, but when in doubt, re-read.
4. Verify the result: edit tools return \`oldContent\`/\`newContent\` so you can confirm the change landed where intended.

### replace_lines — precise range edits

\`replace_lines\` replaces an inclusive, 1-based range \`startLine\`–\`endLine\` (\`endLine\` defaults to \`startLine\`) with \`content\`. Omit \`pageId\` to edit the page currently in view.

- \`content\` may contain newlines — a multi-line string becomes multiple lines.
- **Empty-string \`content\` deletes the range entirely** (reported as \`changeType: 'deletion'\`); it does not leave a blank line.
- The range is validated against the normalized line count: out-of-bounds or inverted ranges fail with \`Invalid line range: X-Y. Document has N lines.\` — a common symptom of stale line numbers.
- It refuses FILE pages (uploads are read-only) and SHEET pages (use \`edit_sheet_cells\` with A1-style addresses instead).

Use it for: rewriting a section, fixing specific lines, deleting content, any edit where you know the exact range from a fresh read.

### insert_content — anchored insertion, no line math

\`insert_content\` inserts \`content\` as new line(s) immediately \`before\` or \`after\` the **first line containing the \`anchor\` substring**. Omit \`pageId\` to edit the page currently in view.

- Pick a distinctive anchor — a heading's text, a unique phrase — remembering that only the *first* matching line wins.
- On html-mode pages the insertion point snaps to the block boundary: \`after\` skips past the closing tags following the anchor line, \`before\` backs up before the opening tags preceding it. So anchoring on a heading's text and inserting \`after\` places your content *after the complete heading element*, not inside it — exactly what you want for "add a section under this heading".
- \`content\` may contain newlines, so you can insert a whole multi-block section in one call.
- **If the anchor is not found, the call still returns \`success: true\` with \`inserted: false\`** and a "not found" message. Always check \`inserted\` — do not assume the write happened.
- Same refusals as \`replace_lines\`: FILE and SHEET pages.

Use it for: appending sections relative to headings or landmarks, adding items near known text — anywhere counting lines is unnecessary risk. Prefer it over \`replace_lines\` when you are adding (not changing) content.

## Writing HTML for html-mode DOCUMENTs

The rich editor's Tiptap 3 schema accepts a specific set of elements. Verified supported:

- **Blocks**: \`<p>\`, headings \`<h1>\` \`<h2>\` \`<h3>\` **only**, \`<blockquote>\`, \`<ul>\`/\`<ol>\` with \`<li>\`, \`<hr>\`, \`<br>\`.
- **Inline marks**: \`<strong>\`, \`<em>\`, \`<s>\`, \`<u>\`, inline \`<code>\`, \`<a href="...">\` links (https is the default protocol).
- **Code blocks**: \`<pre><code class="language-xxx">...</code></pre>\` — the language class drives Shiki syntax highlighting. Escape \`<\`, \`>\`, \`&\` inside as HTML entities.
- **Tables**: \`<table>\`, \`<tr>\`, \`<th>\`, \`<td>\` (table extension).
- **Font styling**: \`<span style="font-family: ...">\` / \`<span style="font-size: ...">\`.
- **Mentions**: see the mentions section below.

Anything outside the schema is silently dropped or unwrapped the next time the document is opened in the editor — even if your write "succeeds". Notably **not** supported: \`<img>\` (no image node), \`<h4>\`–\`<h6>\` (only levels 1–3 are configured), \`<iframe>\`/\`<script>\`/\`<style>\`, \`<div>\`/\`<section>\` wrappers, and checkbox/task-list markup. Do not write them.

Rules of thumb:

- Write **complete, well-formed block elements**. When replacing a range, replace whole blocks — from the line with the opening tag through the line with its closing tag. Leaving an unbalanced \`<p>\` or \`</li>\` corrupts the document structure and breaks future line-normalization.
- Match the normalized shape you read: opening tag, content line(s), closing tag as separate lines is ideal (though the normalizer will fix single-line blocks on the next read).
- For interactive layouts, embeds, or arbitrary HTML/CSS, use a CANVAS page instead — DOCUMENTs are for prose.

## Writing CODE pages and markdown-mode DOCUMENTs

- Content is raw text, byte-for-byte. Never wrap it in HTML, and never wrap a CODE page's content in markdown code fences — the page *is* the file.
- Line numbers are real file lines; \`replace_lines\` behaves like a line-based file editor.
- In markdown-mode DOCUMENTs, write standard markdown (headings, lists, fenced code blocks, tables).

## Mentions in content

Mentions use the syntax \`@[Label](id:type)\` with four types:

- \`@[Page Title](pageId:page)\` — links to a page. When a user @mentions a page at you, read it with \`read_page\` before responding.
- \`@[Name](userId:user)\` — notifies that specific user.
- \`@[Role Name](roleId:role)\` — notifies all drive members holding that role.
- \`@[everyone](driveId:everyone)\` — notifies all drive members; the id is the **driveId** (take it from your LOCATION context if present, otherwise resolve via \`list_drives\` or the resource you're working on).

Notification mechanics: the mention author is never notified, and notifications only reach users who can actually view the page — mentioning someone does not grant access. Use user/role/everyone mentions when your content should actively notify people; use page mentions for cross-references.

In html-mode DOCUMENT content, editor-created mentions persist as anchor/span elements (\`<a class="mention" data-mention-type="page" data-page-id="...">@Label</a>\`, \`<span data-mention-type="everyone">\`/\`<span data-mention-type="role" data-role-id="...">\`). When editing around them, **preserve these elements verbatim** — rewriting them as plain text destroys the link.

## Structure conventions for long-form writing

- The page title is the document's name — don't duplicate it as a heading. Open with a short lead paragraph, then \`<h2>\` sections with \`<h3>\` subsections (three heading levels is all you get; design the outline to fit).
- Give headings distinctive text: they double as stable anchors for later \`insert_content\` calls.
- Short paragraphs; \`<ul>\`/\`<ol>\` for enumerable points; tables for comparisons; \`<hr>\` sparingly as a section divider.
- Build long documents incrementally: \`create_page\`, write the skeleton of headings, then fill sections one at a time with \`insert_content\` anchored to each heading. Small edits produce reviewable diffs; a whole-document \`replace_lines\` of lines 1–N should be a last resort.
- Before creating, \`list_pages\` the destination to avoid duplicating an existing document.

## Common pitfalls

- **Stale line numbers** — editing with numbers from before a previous edit. Re-read after every edit.
- **Format mismatch** — markdown syntax in an html-mode DOCUMENT, or HTML in markdown/CODE pages. Check \`contentMode\` and \`type\` first.
- **Unsupported HTML** — \`<img>\`, \`<h4>\`+, \`<div>\` wrappers: dropped by the editor schema even though the write succeeds.
- **Partial-block replacement** — replacing the text line but not its enclosing tags (or vice versa), leaving unbalanced HTML.
- **Assuming insert_content succeeded** — it returns \`inserted: false\` (not an error) when the anchor isn't found.
- **Forgetting empty content deletes** — \`replace_lines\` with \`content: ""\` removes the lines; to blank a line instead, replace it with a single space or an empty block.
- **Wrong tool for the page type** — SHEET pages need \`edit_sheet_cells\`; FILE pages are read-only; CHANNEL/TASK_LIST are managed through their own tools, not line edits.
`;
