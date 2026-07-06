# Code Review: pu/phase8-credential-security (PR #1878)

Re-reviewed at HEAD `97c94a914` (round-7 remediation). 96 files, ~8135/-489 lines. This is a security-critical PR: closes a credential-minting escalation path in the CLI, adds step-up (WebAuthn/magic-link) re-authentication gating for OAuth-grant revocation and MCP-token minting/scope-editing, and adds named credential profiles.

## Round-7 remediation — verified

Round-7 (`97c94a914`) targeted exactly the blocker + 2 majors below. Verified each against current code, ran typecheck (`cli`/`lib`/`web` all clean) and the touched test files (all pass):

- [x] BLOCKER `login-device.ts` profile isolation — **fixed and verified correct**. `login-device.ts` now calls `resolveProfileName` identically to `login.ts`, threads the resolved name into `store.get(host, profileName)`, the existing-credential message, and a new `profile` field on `DeviceLoginDeps` that `device-flow.ts`'s only `credentialStore.set(...)` call site now passes through. New tests cover `--profile`, `PAGESPACE_PROFILE` env fallback, per-profile existing-credential scoping, and that the overwrite-refusal message never leaks the existing secret.
- [x] MAJOR `ConnectedAppsList.tsx` dialog-not-closing — **fixed and verified correct**. `handleConfirmRevoke`'s `awaiting_email` branch now calls `setConfirmingGrant(null)` alongside `setAwaitingEmailForId`/`setRevokingId`. New test asserts the `alertdialog` role and "Revoke Access" button are both gone after the magic-link fallback fires.
- [x] MAJOR keychain parse-vs-outage scoping in `store.ts` — **fixed and verified correct**. `get()` no longer routes through the shared `withFallback`; a keychain-transport failure still degrades the whole store, but a `parseHostCredential` failure on one entry now throws a distinct `CredentialsFileFormatError` for that lookup only (surfaced cleanly by `bin.ts`'s top-level catch, not a raw stack trace) and leaves `degraded` untouched. `list()` skips a malformed entry with a stderr warning (host name only, never the secret) and keeps returning every other well-formed entry. Confirmed `parseKeychainAccountKey` (called outside the new try/catch in `list()`) is total — it can't throw — so it doesn't reopen the same class of bug for a malformed *account key* instead of a malformed *secret*. New tests cover both `get()` and `list()` against a genuinely malformed entry, alongside an untouched well-formed one, and assert the store stays on the keychain (not degraded) afterward.

No new bugs introduced by round-7's diff (8 files, 238/-37 lines) — it's narrowly scoped to the three items above.

## Prior-round PR-thread triage

The PR already had 14 review threads (CodeRabbit + CodeQL). Verified all 4 still-unresolved ones against current code:

- [x] `packages/cli/src/auth/__tests__/loopback-flow.test.ts:198` "duplicate `setCalls` declaration" — **stale, already fixed**. Each `it` block declares its own local `setCalls`; no duplicate exists in the current file. Thread just wasn't marked resolved.
- [x] `.../MCPSettingsView.test.tsx:687` "assertion contradicts stated intent" — **stale, already fixed**. The component's copy legitimately says "Don't authenticate it with `pagespace login`" as discouragement text, so asserting that phrase is present is correct, not contradictory.
- [x] `ConnectedAppsList.tsx:85` CodeQL "clear text storage of sensitive information" — **likely false positive**. Only `grant.id` (an opaque, non-secret row id) is written to `sessionStorage`, needed to resume revocation after a magic-link redirect. Not a credential/token.
- [ ] `ConnectedAppsList.tsx:98` "confirmation dialog never closes after magic-link dispatch" — **CONFIRMED, still live** (see finding below).

## Findings

- [x] BLOCKER · `packages/cli/src/commands/login-device.ts` (whole file) · `pagespace login --device --profile <name>` / `PAGESPACE_PROFILE=<name>` was silently ignored — **fixed in round-7 (`97c94a914`)**, see verification above.

- [x] MAJOR · `packages/cli/src/credentials/store.ts:45-54,72-87` (the `withFallback` wrapping in `get()`/`list()`) · Malformed keychain entry parse failure was folded into the same catch as "keychain unreachable" — **fixed in round-7 (`97c94a914`)**, see verification above.

- [x] MAJOR · `apps/web/src/components/oauth-grants/ConnectedAppsList.tsx:81-88` (`handleConfirmRevoke`'s `awaiting_email` branch) · Confirm dialog never closed after the magic-link fallback fired — **fixed in round-7 (`97c94a914`)**, see verification above.

- [ ] MINOR · `packages/cli/src/credentials/file-store.ts:56-64` (`set`/`delete`) · Read-modify-write with no advisory lock. Two concurrent CLI invocations touching the same file can race; the temp-file+rename write keeps the file from being *corrupted*, but a concurrent update can be silently *lost* (last rename wins). Low impact for a single-user local CLI, but real and untested. Still open — untouched by round-7.

- [ ] MINOR · `packages/cli/src/run.ts:88` · `deps.credentialStore.get(host, profileName)` runs unconditionally, before the `mcp`-specific ambient-fallback gate, so even a bare `pagespace mcp` invocation that's about to be refused still touches the OS keychain (a `getSecret` call, possibly prompting for Keychain access on macOS) for a result that's discarded. Not a security regression — read-only, no network/mint/refresh — just wasted work / a surprising macOS prompt on a call that will fail anyway. Consider deferring the read until after the mcp gate.

- [ ] NIT · `apps/web/src/app/oauth/consent/ConsentActions.tsx:53` (`decide()`) · No explicit `if (isSubmitting) return;` reentrancy guard, unlike the equivalent `MCPSettingsView.tsx` create/update flows that were hardened for exactly this in an earlier round. Not currently exploitable (button `disabled={isSubmitting}` plus React 18 batching plus WebAuthn's own "request already pending" rejection all cover it), but it's the same shape of gap hardened elsewhere in this PR — worth the same explicit guard for consistency.

- [ ] NIT · `apps/web/src/components/.../mcp/MCPSettingsView.tsx:312-333` (pending-mint/pending-update magic-link resume effect) · If a create-token step-up and an edit-scopes step-up are both left pending (both fell back to magic link before either link was clicked), the effect only resumes whichever storage key (`PENDING_MINT_STORAGE_KEY`) it checks first and never clears the other (`PENDING_UPDATE_STORAGE_KEY`), which goes stale and later fails a server-side action-binding check when eventually replayed (safe — no escalation, just a silently-dropped action and a lost-update UX defect).

## Verified solid (no findings)

- **Step-up core** (`packages/lib/src/auth/step-up-service.ts`, `step-up-decisions.ts`, `mcp-token-scopes.ts`, `oauth/grant-ownership.ts`, `oauth/grant-scope-summary.ts`): action-binding hashing is JSON-encoded and collision-resistant (delimiter-collision fix from a prior round holds, verified at every call site); token/challenge redemption is atomic (`UPDATE ... WHERE usedAt IS NULL RETURNING`) everywhere it's used, closing the TOCTOU race a prior round fixed; grant-ownership collapses not-found/not-owned to an identical 404; no raw (non-hashed) secret comparison anywhere; no JWTs (opaque tokens throughout, per repo convention); adversarial test coverage (forged bindings, reused/expired tokens, cross-user access, mint-vs-update confusion) is present.
- **Prototype-pollution / NUL-byte guards** (`credentials/serialize.ts`, `credentials/keychain.ts`): `Object.hasOwn` used consistently for reads, computed-key object-literal construction (never `obj[key]=`) for writes; NUL-byte guard is a mandatory choke point in every `CompositeCredentialStore` method, before either backend is touched. Well tested including non-enumerable `__proto__` edge cases.
- **File-store atomicity/permissions**: temp-file-in-same-dir + `fs.rename` (atomic, symlink-attack-safe), explicit chmod 0600/0700 re-applied on every write, single-fd permission-check-then-read (no TOCTOU).
- **CLI consent-flow / ambient-auth gating** (`run.ts`'s `mcp` gate, `resolve.ts`'s `hasExplicitCredential`, `tokens create`'s browser-consent path): no bypass found; `tokens create` has no local-minting path left, matching the PR's stated intent; `open-browser.ts` never uses `shell: true` or string interpolation, no injection surface.
- **OAuth grant IDOR surface** (`apps/web/src/app/api/account/oauth-grants/[grantId]/route.ts`, `oauth-repository.ts`): step-up verified before the ownership check; ownership check collapses foreign-grant and unknown-id to the same 404 (no enumeration oracle); repository queries are correctly userId-scoped and exclude already-revoked rows, with explicit tests for both.
- **Docs & changelog** (`README.md`, `docs/agent-access.md`, `docs/migrating-from-pagespace-mcp.md`, `CHANGELOG.md`): accurate, consistent with the code, and clearly scope the actual security boundary (OS user/container/VM, not the token alone).
- **New `packages/lib` subpath exports**: every new auth module (`step-up-service`, `step-up-decisions`, `step-up-constants`, `mcp-token-scopes`, `oauth/grant-ownership`, `oauth/grant-scope-summary`) has a matching `package.json` exports entry — no repeat of the "new subpath module missing exports" class of bug.
- **Typecheck**: `@pagespace/cli`, `@pagespace/lib`, and `web` all typecheck clean at HEAD.

## Hotspot note (not blocking)

`apps/web/src/components/.../mcp/MCPSettingsView.tsx` (1070 LoC pre-PR, +259 by this diff) and `apps/web/src/app/settings/account/page.tsx` (760 LoC pre-PR) were already over the churn skill's complexity/LoC thresholds *before* this PR — this diff didn't push them over, so no refactor is being required here. `MCPSettingsView.tsx` got the largest complexity-adding change in the diff and got extra scrutiny for that reason (see reentrancy-guard verification above); it held up well.

## Round-8 convergence pass — verified (HEAD `b8b6592ea`, post-merge with master)

Re-scanned the PR after a merge from `master` (`39f74f821`, brought in unrelated Phase 9 +
GDPR/GitHub-tooling work — verified no conflict markers, no overlap with this PR's security
surface beyond an additive `packages/lib` export and two already-passing test files) and after all
3 remaining unresolved GitHub review threads were triaged directly against current source:

- [x] `packages/cli/src/auth/__tests__/loopback-flow.test.ts:198` "duplicate `setCalls`" —
  **confirmed stale**, no duplicate declaration exists (each `it` block has its own local const).
  Replied and resolved.
- [x] `.../MCPSettingsView.test.tsx:687` "assertion contradicts stated intent" — **confirmed
  stale/correct-as-is**. The component's Quick MCP Setup copy deliberately retains the phrase
  "pagespace login" as discouragement text ("Don't authenticate it with `pagespace login`..."),
  so asserting its presence is correct; the test's title describes steering intent, not a
  literal-absence requirement. Replied and resolved.
- [x] `ConnectedAppsList.tsx:85` CodeQL `js/clear-text-storage-of-sensitive-data` (alert #250,
  **required check**, newly surfaced as a failing default "CodeQL" status check on this pass) —
  confirmed false positive: the stored value is `grantId`, an opaque OAuth-grant row id used only
  to resume revocation after a magic-link redirect, not a credential/token. CodeQL flags it purely
  because it's derived from `useOAuthGrants`. Fixed with an inline `codeql[js/clear-text-storage-
  of-sensitive-data]` suppression comment (`b8b6592ea`), matching the existing repo convention in
  `apps/web/src/app/api/user/integrations/callback/route.ts`. Replied on the thread but left it
  **unresolved** (fix landed during this pass, not before it) for reviewer verification once the
  new CodeQL analysis run completes on the latest commit.

Cross-checked against the PageSpace epic board (`nfy6g0c1c4c15iguiyozfjga`): all 7 phase tasks are
Done; the two remaining pending tasks (blind-signing UX + `ConsentActions` component test; timing
side-channel + keychain NUL-collision hardening) are explicitly scoped as separate low-priority
follow-up work, not blockers for this PR. Also spot-verified two items the board's round-5/round-6
findings said were fixed by commits already on this branch: `updateTokenScopes()` in
`MCPSettingsView.tsx` has the same creating/step-up-status reentrancy guard as `createToken()`
(`editingScopes || editStepUpStatus !== 'idle'`), and `store.test.ts`'s NUL-byte tests use proper Unicode escape sequences, not raw
embedded NUL bytes (confirmed via `file`, reads as text, not binary).

Local validation: `@pagespace/lib`, `web`, and `@pagespace/cli` typecheck clean; the touched
`ConnectedAppsList.test.tsx` suite (8 tests) passes.

## Verdict

**0 blockers / 0 majors open · 3 minors/nits open (all pre-existing, non-blocking, tracked
separately or matching existing repo convention elsewhere).** Round-7 fixed all three round-6 blocker/major findings (device-login profile isolation, revoke-dialog close, keychain parse-vs-outage scoping); each fix verified correct by direct re-read against current code, backed by new tests that specifically pin the previously-buggy behavior, with `cli`/`lib`/`web` typecheck and the touched test suites all green. No new bugs found in round-7's diff. The step-up-auth core, OAuth grant IDOR surface, prototype-pollution/NUL-byte guards, and file-store atomicity all continue to hold under this pass (unchanged from round-6, re-spot-checked). Remaining open items are all minor/nit, defense-in-depth or UX-polish, none security-critical: file-store's lost-update race under concurrent CLI invocations, a wasted (but harmless) keychain read on a doomed-anyway `pagespace mcp` call, a missing-but-currently-unexploitable reentrancy guard on `ConsentActions.decide()`, and a magic-link pending-key clash between simultaneous mint/update step-ups. **Recommend merge**; the three open minors/nits can be follow-up work, not merge blockers.
