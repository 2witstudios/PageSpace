# Phase B — content census, run against production 2026-08-24

## What it found, and what it overturned

Ran read-only against production: **4,769 DOCUMENT pages** (3,762 html-mode, 1,007 markdown-mode,
318 empty). Every number below is from that run.

### The `<img>` alarm was wrong

Phase B scoping predicted that seeding would permanently delete images, and named five more
constructs alongside. In real HTML documents:

| predicted | actual |
|---|---|
| `<img>` | **0** |
| `<h5>` `<h6>` `<figure>` `<mark>` `<sub>` `<sup>` `<iframe>` | **0** |
| `style:text-align`, `attr:data-type=taskList` | **0** |
| `<h4>` | 14 pages |

The editor has never been able to produce them, so no document contains them. The constructs *do*
appear in markdown source — `md:task-list` 34, `md:strikethrough` 17, `md:raw-html` 11,
`md:heading-4-6` 8, `md:image` 2, `md:highlight` 1 — which makes them Phase K's problem, not
Phase E's.

### The real finding: 3,003 documents are markdown mislabelled as HTML

```
html-mode DOCUMENT pages, non-empty:      3,488
  …containing NO HTML tag at all:         3,003   (86%)
```

Markdown source stored under `contentMode='html'`. Seeding one produces a single paragraph holding
the raw markdown as literal text — every heading, list and code fence flattened, permanently.
That is the catastrophic-seed scenario, and it is not the one anybody was looking for. Own leaf on
the board; Phase E's "Refuse a lossy seed" now carries it as a hard precondition.

It also resizes Phase K: the markdown migration is ~4,000 pages, not the 1,007 that carry the label.

### The headline number was a false positive

"Text lost in the round trip: 3,114 of 3,762" is the same population. Round-tripping tagless
markdown through an HTML parser re-blocks the text and changes its projection; nothing is destroyed
by the schema. 3,114 flagged against 3,003 tagless is the tell.

Diagnosed by adding example page ids to that bucket — it reported a bare count, which made the most
alarming number in the report the only one you could not investigate. Three examples
(`a0jotz7ewamfnl9msomvyn50`, `a1yv3bnm4eve6ariql7tzwnh`, `a278ff0ugbnnzmmo5jpy98ia`) all had an
empty tag histogram and began `# `.

Probed first against synthetic HTML — code blocks with newlines, hard breaks, nested lists, tables
with `thead`, blockquotes, links, mentions, inline code, escaped and unescaped generics — all
preserved text. That ruled out the schema before production data was touched.

## Fix: unescaped angle brackets were flooding the report

`ActionResult<void>`, `Set<string>`, `<task-id>`, even `<noreply@anthropic.com>` — unescaped `<` in
prose and code samples, which happy-dom turns into elements. ~200 phantom rows buried the real
findings. They now collapse into one `text:unescaped-angle-bracket` key: still counted, because
"stored HTML contains unescaped angle brackets" is worth knowing, but never named individually.

**Mutation-checked:** removing the bucketing turns 2 tests red. 72/72 green with it.

## Gates

- `bun run --filter web test -- src/lib/editor/census` — 72 passed
- `bun run typecheck` (monorepo root)

## Deliberately not done

- **No schema freeze.** It was meant to follow the census in the same PR. The census changed what
  the input is: the question is no longer "which of six constructs does v1 need" (answer: in HTML,
  none) but "what do ~4,000 markdown documents need once they are migrated". Freezing v1 against
  the wrong population would be the expensive kind of mistake.
- **No fix for the mislabelled 3,003.** Recorded as its own leaf. It is a production data change
  and belongs in a PR that is only that.
- **Markdown constructs undercount by ~4x** — detection only ran over correctly-labelled pages.
  Re-run once labels are fixed.
