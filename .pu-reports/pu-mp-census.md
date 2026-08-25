# Phase B — content census, run against production 2026-08-24

## What it found, and what it overturned

Ran read-only against production: **4,769 DOCUMENT pages** (3,762 html-mode, 1,007 markdown-mode,
318 empty). Every number below is from that run.

### What the census can and cannot answer

It measures what documents **contain**. The schema must represent what the product **intends**.
Those diverge exactly where a feature is missing, and that is the trap this run walked into.

| construct | pages |
|---|---|
| `<img>` | **0** |
| `<h5>` `<h6>` `<figure>` `<mark>` `<sub>` `<sup>` `<iframe>` | **0** |
| `text-align`, task-list markup | **0** |
| `<h4>` | 14 |

Most of those zeros are tautologies. The editor has no image node, so no document has an image.
**That is not evidence against an `image` node in v1** — images in documents are wanted, they are
simply unbuilt. Under the irreversibility model, adding a node once documents exist is Class B
(version skew, a lockstep client upgrade); including it in v1 is free. Maximal in what it can
represent, minimal in what it commits to keeping.

Positive evidence points the same way: `md:image` appears in markdown source, and ~4,000 markdown
documents migrate onto this surface in Phase K. Without the node they flatten on seed.

What the census does settle is narrower and still worth having: nothing in stored HTML is
*silently* at risk today beyond `<h4>` on 14 pages. Read a zero as a licence to omit only when the
feature already exists and nobody used it.

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
