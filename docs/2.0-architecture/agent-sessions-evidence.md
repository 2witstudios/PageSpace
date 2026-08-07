# Agent Sessions — the evidence manifest

Status: normative. Companion to [`agent-sessions.md`](./agent-sessions.md), which states the
**contract**. This document is about the **proof**: which executing test backs each user-facing
guarantee, and what is not backed by anything yet.

The data lives in [`agent-sessions-evidence.json`](./agent-sessions-evidence.json) and is
enforced by [`scripts/check-evidence-manifest.ts`](../../scripts/check-evidence-manifest.ts),
which runs in the `unit-tests` job of `.github/workflows/ci.yml`.

## Why the data is JSON and this file has none of it

There is exactly one copy of every claim. A prose table listing guarantee → test would be a
second copy, and the copy nobody re-runs is the one that goes stale — which is the failure this
manifest exists to end, not to reproduce. So the JSON is the single source of truth and this
file deliberately contains **no per-guarantee data**: it explains the format, the rules and the
wiring, and cannot drift from the manifest because it says nothing the manifest also says.

Read the current state by running the checker, which prints it:

```
bun run scripts/check-evidence-manifest.ts
```

## What the checker enforces

A citation is only worth something if something checks it. Four failure modes, all fatal:

| Code | Fires when |
|---|---|
| `MISSING_FILE` | A cited test file was moved or deleted. |
| `MISSING_TEST` | The file exists but declares no test with the cited name — someone reworded an `it(...)` and the citation quietly stopped pointing at anything. |
| `SKIPPED_TEST` | The cited test is `.skip` / `.fixme` / `.todo`, or sits inside a `describe.skip`. It reads as evidence and executes nothing. |
| `UNRUN_SUITE` | The cited test lives in a suite **no CI job runs**. |
| `MALFORMED` | A guarantee is neither honestly proven nor honestly a gap (see below). |

`UNRUN_SUITE` is the one that motivated the manifest. Before this was wired up, `apps/e2e`
contained the Playwright specs proving the epic's headline user stories — a server dispatch
rendering live in an open pane, two windows seeing both sides, the pane grid converging across
two devices — and there was **no e2e job in `.github/workflows/` at all**. The specs were green
and ungated: they only ever ran when a human remembered to run them, and their own file headers
said so. A manifest that could cite them without noticing that would have been worse than no
manifest, because it would have read as proof.

It is enforced against the workflow files themselves, never a list hardcoded in the checker.
Each suite in the manifest declares `ciEvidence`: a workflow path plus a literal marker that
must appear in it. Delete the e2e job and the marker vanishes and CI fails. Suites whose runner
needs each file named by hand — `scripts/__tests__`, whose files are listed one by one in the
"Run backfill script tests" step — also set `requiresFileListedInCi`, which forces every cited
file's basename to appear literally in the workflow. Writing this manifest immediately caught
one live instance: `scripts/__tests__/tenant-export-columns.test.ts`, 64 passing tests that had
never once run in CI.

## Gaps are recorded, not omitted

A guarantee with no executing evidence is written down as `"status": "gap"` with a
`TODO(owner)` marker. It is never silently dropped, and the checker rejects a gap without an
owner marker as `MALFORMED` — so a gap cannot be downgraded into a blank. Likewise a guarantee
marked `"proven"` with an empty citation list is `MALFORMED` rather than vacuously passing.

The point is that the manifest is honest about what is unproven. A guarantee absent from the
list looks like it was never considered; a guarantee present and marked as a gap is a debt with
a name.

## What the checker cannot see

Worth knowing before trusting a green run:

- **Silent-green suites.** Some integration suites gate every test body on a `dbAvailable`
  probe set in `beforeAll` rather than reporting a skip, so with no reachable Postgres they
  pass with zero assertions and no signal. That is invisible to a static check — it is not
  `it.skip` — and it is the same shape of failure that has already hidden a real CI break once.
  Affected citations carry a note in the manifest.
- **Whether a test proves what its name claims.** The checker verifies that a named,
  executing test exists in a suite CI runs. It cannot verify the assertion is meaningful. That
  is what review is for — and why several entries cite a *harness pin* alongside the headline
  spec, so a green assertion cannot come from a no-op setup.

## RED GATE: what turning the gate on revealed, and how it closed

This section is kept as a record. The gate went in red, the failure it exposed was real, and
**it is now green** — the whole point of wiring it up, start to finish.

Runs 1–2 are local, on the tree before this branch merged `pu/broken-sessions`. Runs 3–4 are the
CI job on the merged tree (workflow `31156153232`, the second a re-run of the same job on the
same commit). Run 5 is the CI job after the branch was refreshed onto the integration branch
carrying **#2363, the socket-churn fix** (workflow `31160491225`).

| Spec | 1 (local) | 2 (local) | 3 (CI) | 4 (CI) | 5 (CI, post-#2363) |
|---|---|---|---|---|---|
| `16` — a server dispatch into an open pane renders live without reload | **FAIL** | **FAIL** | **FAIL** | FAIL → pass on retry | **pass** |
| `16` — two windows on one conversation both see both sides live | **FAIL** | **FAIL** | **FAIL** | **FAIL** | **pass** |
| `17` — a split in one window appears in the other LIVE, with no reload | **FAIL** | **FAIL** | pass | pass | **pass** |
| `17` — converges in BOTH directions: a close in the second window reaches the first | **FAIL** | **FAIL** | pass | pass | **pass** |
| `17` — convergence is DURABLE: a window opened afterwards sees the same grid | pass | **FAIL** | pass | pass | **pass** |
| **Totals** | 7 / 4 | 6 / 5 | 9 / 2 | 9 / 1 | **11 passed, 0 failed** |

The clincher is not the column of passes, it is the **clock**. Runs 3 and 4 took 3.5 and 4.1
minutes, with the failing assertions burning their full 15-second timeout. Run 5 took **34
seconds** for all eleven, with the two `16` live-delivery specs settling in 2.1s and 3.1s. They
are not passing by a narrower margin than before; the wait that used to expire is simply gone.

That also explains the run 3–4 anomaly this table previously recorded as unexplained — the three
`17` specs passing in CI while failing locally. The bug was a reconnect storm, so delivery was a
race, not a brick wall: a faster machine won it often enough to look fixed. That is exactly why
"passes in CI" was not accepted as evidence at the time, and the caution was right — the bug was
still there.

Everything with no live-socket dependency passed in every run, before and after: both `16`
persistence smokes and all three `15` chat smokes.

The server side was verified healthy in the same run — realtime logged **197**
`User joined conversation room` entries for the correct `conv:<id>`, and **148** broadcasts were
sent, including `conversation:message_created` / `conversation:message_updated` to that exact
room, one second after the client joined it.

The failure was on the client. A single test produced **33** `Creating new Socket.IO connection`
log lines, 33 socket-token fetches and 11+ distinct socket ids, with **no** authentication
errors and **no** disconnect reasons — the socket store churned connections. No socket survived
long enough to upgrade off polling (the trace contains zero websocket upgrade attempts), so a
broadcast landed in a window where the current socket had not yet re-joined, and the pane stayed
blank. That was `apps/web/src/stores/useSocketStore.ts` reconnect behaviour, not a transport or
CSP problem — and it is what **#2363** fixed.

`"status": "proven"` in the manifest means **cited, executing, and gated by CI**. It does not
mean currently green, and that separation is deliberate even now that the gate is green: the
checker verifies that a named test exists, runs, and is in a suite CI executes; whether it
*passes* is what the CI job itself reports. A manifest that could only cite green tests would
have quietly dropped these five the moment they broke — the precise failure it exists to
prevent, and the reason the citations survived the whole red period above to be vindicated by
run 5 rather than being deleted somewhere around run 2.

### Spec `18`, added after the gate went green

`18-sidebar-directory-live.spec.ts` joined the same job to close the last recorded gap — the
listener→SWR-key→`AgentsSidebar` seam, which every other test in the epic proved only either
side of. It runs on the identical topology (production build, realtime same-origin behind the
proxy, `NEXT_PUBLIC_REALTIME_URL` unset). All three of its assertions were confirmed to fail —
on the assertion, not on setup — with the listener's key predicates diverged from the sidebar's
key, which is the drift they exist to catch.

It is also the clearest example so far of the section above this one: **a spec that cannot fail
is worse than no spec.** The first draft blocked the session-listing GET and asserted the row
appeared anyway. It passed. It also passed with the `conversation:created` subscription deleted
— because two separate harness faults meant the "block" blocked nothing (the app registers
`/sw.js`, and Playwright cannot intercept a fetch that goes through a Service Worker; and a
`'**/api/agent-workspaces**'` URL glob matched nothing where an exact-pathname predicate
matches), so the refetch it claimed to have ruled out was quietly delivering the row the whole
time. Only running it against a deliberately broken build surfaced that. The rule this earns:
**a spec whose assertion depends on suppressing something must prove the suppression happened,
and the only reliable proof is a run that fails.**

Fixing the harness then exposed a product fact worth recording rather than working around:
creation and session-binding are decoupled (`create-conversation-in-session.ts`), so on the
spawn path `conversation:created` carries `workspaceId: null` and the sidebar is updated by the
claim's `conversation:updated` — one **event-driven refetch**, not a request-free cache write.
The guarantee holds (event-driven, not a poll); the stronger "with no request" reading does not,
and the spec now says so by shape: the spawn test rules the poll out with a quiet-window control
instead of a network block, and a second test takes the seam to full strength on
`conversation:closed`, which really is request-free.

## Adding a guarantee

1. Add an entry to the JSON with an `id`, the user-facing `guarantee` (phrase it as something a
   user would notice breaking, not as an implementation detail), and either `evidence` or a
   `gap` with `TODO(owner)`.
2. Copy test names **exactly** from the source — the literal string passed to `it()`/`test()`,
   not a paraphrase. Templated names (`` `... ${surface} ...` ``) are matched with the
   substitution treated as a wildcard.
3. Every cited file must fall under a declared suite's `pathPrefixes`, and that suite must have
   `ciEvidence` proving a job runs it. If it doesn't, the honest move is to add the CI job —
   that is the whole point.
4. Run `bun run scripts/check-evidence-manifest.ts`.

## The e2e job's topology, and why each part is required

The `e2e` job in `.github/workflows/ci.yml` runs specs 15/16/17. It reproduces the local
topology documented in the header of `apps/e2e/tests/16-dispatch-multiplayer.spec.ts`, and
every piece is load-bearing:

- **Production build, not `next dev`.** The app's CSP has no `unsafe-eval` in `script-src`, and
  the dev bundler needs eval to hydrate. Under `next dev` the page renders but never becomes
  interactive, and every spec fails looking like an app bug.
- **Same-origin sockets via a reverse proxy** (`apps/e2e/support/e2e-proxy.ts`). The CSP is
  `connect-src 'self' ws: wss:` and Socket.IO opens with an XHR **polling** handshake before it
  upgrades. A cross-origin realtime server therefore gets that handshake blocked, no socket
  connects at all, and — this is the dangerous part — the live-delivery specs **still pass**,
  off the mount-time refetch. They would be testing nothing, silently and permanently.
  Production avoids this because Traefik path-routes `/socket.io` to realtime on the app's own
  host; the proxy is that rule with no dependencies. `NEXT_PUBLIC_REALTIME_URL` stays **unset**
  so the socket store falls back to same-origin. Do not "fix" a socket problem here by relaxing
  the CSP or setting `bypassCSP` — both stop the run testing the shipped policy.
- **Readiness probed through the proxy.** The wait step requires a `"sid"` from
  `/socket.io/?EIO=4&transport=polling` **on the proxy port**, which proves the route actually
  reaches realtime. Probing realtime directly would pass with the proxy rule broken.
- **Scope: specs 15/16/17 only.** The metering and real-storage specs need Stripe and S3
  credentials and cost more runner time than their regression risk justifies here. Widening the
  job means widening its spec list *and* the manifest's citations — `requiresFileListedInCi`
  ties the two together.
