# Review: pu/github-tooling-updates (PR #1879)

Reviewed: 2026-07-05
Branch: `pu/github-tooling-updates` vs `master` (21 files, +3399/-413), plus two already-landed
follow-up fix commits (`85d150dd6`, `0d27629d6`) from a prior review round.
No PageSpace board tracks this PR (confirmed via `multi_drive_search` across all 3 connected
drives) — recording here per the review skill's repo-log fallback.

Scope: GitHub OAuth integration REST tools (`packages/lib/src/integrations/`) + sandbox git/gh
CLI toolkit (`apps/web/src/lib/ai/tools/sandbox-git-tools.ts`) + centralized GitHub-tool
suppression (`apps/web/src/lib/ai/core/integration-tool-resolver.ts`, `tool-filtering.ts`).

Method: 3 independent agents (GitHub-integration security, sandbox-CLI security, suppression
architecture) + self-run churn/hygiene pass. Both blockers below were independently reproduced
(not just agent-asserted) — see verification notes.

## Findings

- [x] BLOCKER · `packages/lib/src/integrations/execution/build-request.ts:10-36` (`isDotSegment`/`assertNoTraversal`/`assertPlainIdentifier`) · Path-traversal guard checks the raw literal string, but `buildHttpRequest` (line 192) assigns the result to `URL.pathname`, which normalizes percent-encoded (`%2e%2e`) and backslash dot-segments the same as literal `..` — the validator and the consumer disagree, so encoded payloads bypass validation and still traverse. · Verified independently with `node`: `new URL('https://api.github.com'); u.pathname='/repos/acme/webapp/contents/%2e%2e/%2e%2e/other-org/other-repo/contents/secret.txt'` → normalizes to `/repos/acme/other-org/other-repo/contents/secret.txt`, identical to the literal-`..` case the existing tests already block. Also reproduces on a *plain-identifier* param (not just `rawPathParams`): `owner: '%2e%2e'` on `/repos/{owner}/{repo}` collapses to `/webapp`, escaping the `/repos/` prefix entirely. Affects every path-interpolating tool: `get_repo_content`/`create_or_update_file`/`delete_file` in `github.ts` and the three `{path}` tools in `generic-webhook.ts`. — **fixed**: `isDotSegment` now matches the WHATWG URL Standard's literal single-/double-dot-segment definitions (`.`, `%2e`, `..`, `.%2e`, `%2e.`, `%2e%2e`, ASCII case-insensitive) instead of only `.`/`..`; both `assertNoTraversal` and `assertPlainIdentifier` also reject any literal backslash outright (the URL parser treats `\` as a path separator for special schemes like https, and no legitimate GitHub API path segment needs one). Confirmed empirically against real `URL` normalization behavior (including that `%2f`/`%252e`/`%5c` do *not* get decoded by `URL`, so no double-decode step is needed, and that legitimate dotted paths like `.github/workflows/ci.yml` are unaffected).

- [x] BLOCKER · `apps/web/src/lib/ai/tools/sandbox-git-tools.ts:558` (`git_rebase`, param `branch_or_ref`) · No `startsLikeFlag` guard (unlike `git_show`'s `ref`, which got one in `85d150dd6`), so `branch_or_ref: '--exec=<cmd>'` becomes argv `['rebase', '--exec=<cmd>']` — a real git flag that shell-execs `<cmd>` after each replayed commit. · Verified independently by reading the code path end-to-end: `git()` (line 140-141) calls `runGitInSandbox` with no `preResolvedToken`, so `git-tool-runners.ts:67-70` unconditionally resolves and injects `GH_TOKEN`/`GITHUB_TOKEN` into the child env whenever the user has a GitHub connection (`git-tool-runners.ts:111-120`) — including this "local" git command. An attacker who can influence `branch_or_ref` (e.g. content echoed back from an untrusted PR/issue body) gets both arbitrary command execution in the sandbox and exfiltration of the user's GitHub OAuth token via `$GH_TOKEN`/`$GITHUB_TOKEN` in the exec'd command — the exact credential the system prompt says the plain `bash` tool deliberately lacks. — **fixed**: added the same `startsLikeFlag` `.refine()` + execute-time check used by `git_show`'s `ref`.

- [x] MAJOR · `apps/web/src/lib/ai/tools/sandbox-git-tools.ts:524` (`git_merge`, param `branch`) · Also a bare positional with no `startsLikeFlag` guard. `git merge` has no `--exec`, but `--strategy=<name>`/`-s<name>` makes git exec `git-merge-<name>` off PATH — a flag-injection primitive (and a way to silently force `-X theirs`/`--no-verify` semantics) even without direct RCE. — **fixed**: same guard pattern added.

- [x] MAJOR · `packages/lib/src/integrations/execution/build-request.test.ts`, `packages/lib/src/integrations/providers/github.test.ts`, `packages/lib/src/integrations/providers/generic-webhook.test.ts` · All new traversal tests use only literal `../` payloads; none cover `%2e%2e`, mixed-case percent-encoding, `.%2e`/`%2e.`, or backslash variants — so the entire new suite is green despite the BLOCKER above. — **fixed**: added RED tests for percent-encoded, mixed-case, `.%2e`, and backslash variants in `build-request.test.ts` (plus a legitimate-`.github/`-path preservation test), and one confirmatory encoded-traversal test in each of `github.test.ts` (get/create/delete file content tools) and `generic-webhook.test.ts`.

- [x] MAJOR (test gap mirroring the vuln) · `apps/web/src/lib/ai/tools/__tests__/sandbox-git-tools.test.ts` · Has "rejects a value that looks like a flag" tests for `git_show`, `gh_workflow_run`, `gh_repo_view`, `gh_repo_list`, `gh_repo_fork`, `gh_repo_create`, and `gh_search`'s `--` placement, but none for `git_merge`'s `branch` or `git_rebase`'s `branch_or_ref` — the two gaps above. — **fixed**: added the missing pair (`git_merge action` / `git_rebase action` describe blocks), each asserting `success: false` and that `acquireSandbox` was never called.

- [x] MINOR · `apps/web/src/app/api/ai/chat/route.ts` (and the global-messages route) suppression fix · No end-to-end route-handler test exercises `toolExposureMode: 'search'` with sandbox tools present — the exact scenario the original suppression bug manifested in. — **fixed** (chat/route.ts only; global-messages route left as a follow-up, see below): added `apps/web/src/app/api/ai/chat/__tests__/sandbox-github-suppression.test.ts`, asserting `resolvePageAgentIntegrationTools` receives a `currentTools` set that still contains the sandbox tool name even in `'search'` mode. Regression-tested: temporarily reverted the route to pass the post-exposure set and confirmed this new test fails (`expected {...} to have property "git_clone"`), then restored the correct code and confirmed it passes again — the test is a genuine tripwire, not a vacuous pass.

## Verdict

2 blockers / 3 majors / 1 minor / 0 nits. **6/6 fixed.**

Both blockers were genuine, independently-reproduced security holes that defeated protections this
same PR claimed to have just landed (`0d27629d6` path-traversal fix, `85d150dd6` CLI arg-injection
fix) — the original fixes covered the reported PoCs but not adjacent variants (encoding, and one
sibling tool). All fixes verified: `bun test` green on every touched unit-test file (192 packages/lib
+ 187 apps/web tests, all passing via vitest — apps/web tests require vitest, not bare `bun test`),
`tsc --noEmit` clean on both `apps/web` and `packages/lib` when invoked directly (the one observed
typecheck failure was a stale `.next/types` cache artifact from running via `turbo` at the repo root,
reproduced identically on a fully-stashed clean baseline — pre-existing worktree noise, not a
regression from this changeset).

**Follow-up (not blocking, not done here):** the MINOR fix only added a route-level suppression test
for `chat/route.ts` (page-agent route). The global assistant route
(`apps/web/src/app/api/ai/global/[id]/messages/route.ts`) has the identical gap and would benefit
from the same test pattern — left out here to keep the fix pass scoped to what was explicitly found.
