# Phase B — content census, run against production 2026-08-25

Two runs, and the second one exists because the first one's most-quoted number was a tautology.

## Round one: what it found, and what it overturned

Ran read-only against production: **4,771 DOCUMENT pages** (3,762 html-mode, 1,009 markdown-mode,
318 empty). Every number below is from the latest run.

### What the census can and cannot answer

It measures what documents **contain**. The schema must represent what the product **intends**.
Those diverge exactly where a feature is missing, and that is the trap the first run walked into.

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
represent, minimal in what it commits to keeping. Read a zero as a licence to omit only when the
feature already exists and nobody used it.

### The real finding: most html-mode documents are markdown mislabelled as HTML

```
html-mode DOCUMENT pages, non-empty:      3,488
  …containing NO HTML element at all:     3,169   (91%)
```

Markdown source stored under `contentMode='html'`. Seeding one produces a single paragraph holding
the raw markdown as literal text — every heading, list and code fence flattened, permanently. That
is the catastrophic-seed scenario, and it is not the one anybody was looking for. Own leaf on the
board; Phase E's "Refuse a lossy seed" carries it as a hard precondition.

It also resizes Phase K: the markdown migration is ~4,200 pages, not the 1,009 that carry the label.

**3,169, not the 3,003 first reported.** That figure came from an ad-hoc query run beside the
census; this one is measured by the scan itself and excludes the parser's own artefacts. The gap is
the 183 pages that contain an unescaped `<` in prose or a code sample: a query looking for a tag
finds `<string>` in `Set<string>` and calls the page HTML.

### The headline text-loss number was a false positive

"Text lost in the round trip: 3,114 of 3,762" is the same population, and 3,114 now sits **inside**
the 3,169 rather than beside 3,003. Round-tripping tagless markdown through an HTML parser re-blocks
the text and changes its projection; nothing is destroyed by the schema.

Diagnosed by adding example page ids to that bucket — it reported a bare count, which made the most
alarming number in the report the only one you could not investigate. Three examples
(`a0jotz7ewamfnl9msomvyn50`, `a1yv3bnm4eve6ariql7tzwnh`, `a278ff0ugbnnzmmo5jpy98ia`) all had an
empty tag histogram and began `# `.

Probed first against synthetic HTML — code blocks with newlines, hard breaks, nested lists, tables
with `thead`, blockquotes, links, mentions, inline code, escaped and unescaped generics — all
preserved text. That ruled out the schema before production data was touched.

### Fix: unescaped angle brackets were flooding the report

`ActionResult<void>`, `Set<string>`, `<task-id>`, even `<noreply@anthropic.com>` — unescaped `<` in
prose and code samples, which happy-dom turns into elements. ~200 phantom rows buried the real
findings. They now collapse into one `text:unescaped-angle-bracket` key (183 pages): still counted,
because "stored HTML contains unescaped angle brackets" is worth knowing, but never named
individually.

## Round two: real evidence for images, and for turning pagination on

Round one left three things undone, and each one was load-bearing.

### 1. The mislabelled population was never scanned as markdown

Markdown detection ran only over the 1,009 pages that carry the label — a quarter of the markdown
that exists. It now runs over the tagless html-mode pages too, in their own table so the labelled
numbers stay comparable between runs.

| construct | labelled markdown | mislabelled as html |
|---|---|---|
| `md:task-list` | 34 | **325** |
| `md:heading-4-6` | 8 | 18 |
| `md:raw-html` | 11 | 13 |
| `md:highlight` | 1 | 3 |
| `md:image` | 2 | **0** |

Task lists are a **ten-fold** undercount, not the four-fold the first report guessed, and they are
now the largest single schema gap the census has found. Images are the opposite: the mislabelled
population contains none at all.

### 2. Images: 9 instances, on 2 pages, and one of them is the finding

```
where images point (scheme only — never a URL)
  img-src:pagespace-file        1 page
  img-src:relative              1 page
external image hosts            (none)
images in one document          7 (max)
```

This is thin evidence, and it has to be reported as thin. The census can now say something better
than a tautology about images, but what it says is: **there is almost no image content in
production, and the argument for an image node in v1 rests on product intent, not on the corpus.**
That argument is unaffected — a node is free in v1 and Class B afterwards — but it should not be
dressed up as a measurement. The first PR body's "positive evidence points the same way: `md:image`
appears in markdown source" is two pages.

What the run does settle, and could not have been guessed:

- **No `data:` URIs anywhere.** The CRDT-bloat hazard does not exist in the corpus yet, so paste and
  migration only have to keep it that way rather than clean it up. Base64 bytes in a Y.Doc are
  replicated to every client and never forgotten.
- **No external hosts at all.** Nothing is hotlinked, so Phase K needs no ingestion pipeline and v1
  need not decide whether to proxy somebody else's CDN.
- **One of the two pages already points at `/api/files/{id}/view`.** Somebody hand-wrote the
  file-serving URL into markdown to get an image into a document, which is a user routing around the
  missing node — and it names the attribute shape: a stable internal reference the client resolves
  at render time, never a signed URL, which in a CRDT would be permanent, expiring and leaky at
  once.

### 3. Pagination: the corpus already contains blocks no page can hold

`PaginationPlus` exists, is wired behind `isPaginated`, and is unreachable — `DocumentView.tsx:399`
hardcodes `isPaginated={false}`. It is decoration-based, which is the right shape for a CRDT (it
adds no nodes), but it breaks pages BETWEEN blocks and nothing splits a block.

```
pages with isPaginated set        0
lines in one code block         261   (a US Letter page holds ~40)
rows in one table                57
columns in one table             15
characters in one block      16,582
```

Nobody has the switch set, so flipping the default is safe as a data matter. Turning it on is not:
today's documents already contain a single code fence six pages tall and a single block of 16.5k
characters. Overflow handling is a precondition for the pagination work, not a polish item — and
images are about to join that list as the one block whose height is unknown until it loads, which is
the argument for intrinsic `width`/`height` on the node at insert time.

### 4. `md:strikethrough` was never a gap

Raised in review on #2495 and confirmed: StarterKit ships the `strike` mark and the bubble menu
exposes it, so 17 documents were sitting in a table headed "syntax the schema has no node for" that
the schema represents perfectly. Removed from the tally, and `round-trip.test.ts` now holds `<s>` to
surviving the round trip so the claim is pinned rather than asserted.

## Gates

- `bun run --filter web test -- src/lib/editor/census` — 124 passed
- Mutation-checked, each independently red: the credentials check in `hostOf`, the `data:` branch,
  `hasHtmlElement` ignoring the unescaped-bracket bucket, the markdown table header counting as a
  row, the mislabelled tally being kept separate, image buckets counting pages not instances, the
  ten-host cap, and magnitudes measuring the stored document rather than the round trip.
- Production run: read-only via `fly proxy`, `default_transaction_read_only` asserted at startup.
  The html construct tallies and the text-loss counts are **unchanged** from round one, which is
  what makes the two runs comparable.

## Deliberately not done

- **No schema freeze.** The input changed again: the largest gap is task lists (359 pages across
  both populations), not any of the six constructs v1 was going to be argued about.
- **No fix for the mislabelled 3,169.** Own leaf. It is a production data change and belongs in a PR
  that is only that.
- **No image node, no upload path, no `isPaginated` wiring.** This run is the evidence; each of
  those is its own decision.
