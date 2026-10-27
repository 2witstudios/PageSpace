# Review: pu/ios-signin-hang-fix-round2 — PR #2306

fix(auth): timeout unguarded refresh fetches, add signin recovering failsafe

## Context
Round 2 of the iOS signin hang: a TestFlight user remained permanently stuck on "Welcome
back / Loading..." after round 1 (#2291, merged) timeout-guarded two Keychain-read hangs.
This round timeout-guards the two previously-unbounded `fetch()` calls in the same recovery
chain (`refreshBearerSession()`'s refresh POST, `checkMeAuthenticated()`'s `/api/auth/me`
call) and adds an unconditional failsafe timer on `recovering` as defense in depth. Full
self-review (correctness, OWASP top 10, test coverage) plus two automated reviewers
(CodeRabbit, chatgpt-codex-connector) on commit 9466d1c8, both fixed in 65fe782f2.

## Findings

- [x] MAJOR · `apps/web/src/lib/auth/auth-fetch.ts:652` (pre-fix) · `refreshBearerSession()`'s `AbortController` timeout was disarmed (`clearTimeout` in a `finally`) immediately after the `fetch()` await resolved — but `fetch()` resolves once response headers arrive, not once the body is fully read. A server that flushes headers then stalls mid-body would hang indefinitely in the subsequent `response.json()` call with no timeout protection, reintroducing the exact class of bug this PR exists to fix, one step later — and since this leaves `isRefreshing`/`refreshPromise` permanently set, it wedges auth for the whole app session, not just this page load. Correct is: keep the same controller armed through the full request+response cycle. — fixed in 65fe782f2 (chatgpt-codex-connector P1, coderabbitai major — same finding from both reviewers)
- [x] MAJOR · `apps/web/src/app/auth/signin/useSigninRecovery.ts:129` (pre-fix) · The failsafe timer cleared `recovering` but did not mark the run cancelled. If a still-unbounded step (the web/desktop device-token refresh paths, which have no timeout of their own yet — deferred follow-ups) resolved after the failsafe already showed the form, `run()` could still reach the `redirect` action and call `router.replace()`, yanking the user away from a form they'd already started using (e.g. mid-passkey/magic-link/OAuth attempt). Correct is: set `cancelled = true` in the same branch, same as the unmount cleanup already does. — fixed in 65fe782f2 (chatgpt-codex-connector P2, coderabbitai major — same finding from both reviewers; coderabbitai's proposed diff applied verbatim)
- [x] MAJOR · `apps/web/src/app/auth/signin/useSigninRecovery.ts:26` (pre-fix, found via proactive self-review, not an external comment) · `RECOVERY_FAILSAFE_TIMEOUT_MS` was 12000ms, sized only for `hasDeviceToken` (3s) + `checkMeAuthenticated` (8s). The actual worst-case *bounded* chain on the bearer platforms (iOS/Android) this bug targets also includes `refreshBearerSession`'s own two-stage timeout (Keychain read + refresh POST, ~11s), for a true worst case of ~22s — the original budget didn't account for the refresh step at all. A legitimately slow (not hung) full recovery could have hit the failsafe mid-chain, prematurely flashing the signin form. Correct is: size the failsafe to the actual full chain plus margin. — fixed in 65fe782f2 (raised to 25000ms, math documented inline)

## Verified, no change needed
- OWASP Top 10 pass over the diff: no injection surface (endpoint is a hardcoded string literal, not user-controlled — no SSRF), no access-control changes, no crypto/secrets touched. Auth-relevant check: every new timeout fails *closed* (transient/not-authenticated), never grants unauthorized access on abort — confirmed no fail-open regression.
- `bun run knip:check` — 4 issues, all within the existing baseline; the two new exported constants (`CHECK_ME_TIMEOUT_MS`, `RECOVERY_FAILSAFE_TIMEOUT_MS`) are consumed by the new regression tests, not flagged as unused.
- No overlap between this branch's changed files and the 9 commits `master` gained while this branch was open (`pu/pane-to-session` merge) — rebased cleanly, re-verified full suite green post-rebase.

## Verdict
0 blockers / 0 majors / 0 minors / 0 nits outstanding; 3 fixed (3 majors: 2 from paired
external review + 1 from proactive self-review) in commit 65fe782f2. 37/37 tests passing
(`useSigninRecovery.test.ts`, `signin-recovery.test.ts`,
`auth-fetch-refresh-bearer-session-timeout.test.ts`); `bun run typecheck`, `bun run lint`
(changed files), `bun run knip:check` all clean.
