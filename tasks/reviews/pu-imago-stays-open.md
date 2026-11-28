# Review: pu/imago-stays-open (PR #2942)

Self-review of the change that stops agent (AI_CHAT) pages from folding Imago on entry:
`apps/imago/src/ui/files/page-types/agent-page.tsx`, `apps/imago/src/ui/frame/stage/stage.ts`,
their tests and `CHANGELOG.md`. There are no PageSpace task pages for this repo's own work, so
findings are recorded here per the review skill's fallback.

Scope check (owner decisions): no view folds or closes Imago by default; the viewer's own
Collapse, Close and tablet scrim stay sticky across views. After this change, the only
`collapseImago`/`closeImago` dispatches in `apps/imago/src` are `controls.tsx` (the two
buttons) and the `shell.tsx` scrim. `columnsFor` reads only stored state and the screen
width, never the route or page type.

OWASP Top 10 (A01 Broken Access Control, A02 Cryptographic Failures, A03 Injection,
A04 Insecure Design, A05 Security Misconfiguration, A06 Vulnerable Components,
A07 Identification and Authentication Failures, A08 Software and Data Integrity Failures,
A09 Logging and Monitoring Failures, A10 SSRF): not applicable. The diff only removes a
client-side UI-state dispatch and its helper; it adds no input handling, network calls,
auth, storage or dependencies.

## Findings

- [x] MINOR · `agent-page.test.tsx:254` · The rewritten "leaves Imago where the viewer put it" test covered two scenarios in one, with an unmount and a state reset in between. It set state through hand-written `setUiState` spreads instead of the `collapseImago`/`expandImago` transactions the neighbouring test uses. The open case also duplicated the first test. · What correct looks like: one test for the folded case, set up with `dispatch(transactions.collapseImago)`. — fixed in the follow-up commit on this branch
- [ ] NIT · `shell.tsx:95` (outside this diff) · `notFoundColumns` always shows Imago docked and ignores `imagoCollapsed`. On a drive-not-found page, Imago reappears even if the viewer collapsed it. It never hides Imago, so it doesn't conflict with this PR's goal. · What correct looks like: build those columns from the viewer's stored Imago state. Left for a follow-up.

Verdict: approve. 0 blockers / 0 majors / 1 minor / 1 nit; 1 fixed.
