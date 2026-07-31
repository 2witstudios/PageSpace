# Review: pu/globl-ass — PR #2282

feat(agents): let a global-assistant session host any accessible agent

## Context
Global-assistant sessions (`driveId === null`) previously could only host assistant threads. Verified
that both the sandbox tenant/payer (`resolveSessionTenantId`/`resolveSessionPayerId`) and per-agent view
permission checks are keyed independently of the cross-drive gate, so relaxing the gate for global
sessions only is safe. Full self-review (correctness, OWASP top 10, test coverage) plus two automated
reviewers (CodeRabbit, chatgpt-codex-connector) on commit 8384f8063.

## Findings

- [x] BLOCKER · `apps/web/src/components/agents/AgentPageView.tsx:433` (pre-fix) · `AgentPanes` was given `page.driveId` (the hosted agent's own drive) instead of the session's own driveId — now reachable-wrong once a global session can host a cross-drive agent's conversation (previously provably impossible). Correct is: resolve the SESSION's real driveId and pass that. — fixed in da06aedda (chatgpt-codex-connector, P2)
- [x] MAJOR · `apps/web/src/components/agents/panes/AgentPanes.tsx:153` (pre-fix) · Cross-drive picker/selector entries carried only `{id, title}`, losing drive identity — two drives could hold identically-titled agents, indistinguishable in the global session's aggregated list. Correct is: carry and render `driveName` for cross-drive entries. — fixed in da06aedda (chatgpt-codex-connector, P2)
- [x] MINOR · `apps/web/src/components/agents/panes/__tests__/AgentPanes.test.tsx:755` (pre-fix) · New cross-drive picker tests used a fixture where both mock agents were on `drive-1`, so the test could pass even against a narrower, buggy single-drive filter. Correct is: agent-2 on a distinct drive. — fixed in da06aedda (coderabbitai)
- [x] NIT · `apps/web/src/components/agents/panes/AgentPanes.tsx:744` · `canPickAssistant` hardcoded-true comment still described issue #2263 finding 8 as "to confirm" — now confirmed intent given both directions (assistant-in-drive, any-agent-in-global) are deliberately symmetric. — fixed in da06aedda (self-review)

### Second pass — 4-angle /simplify review on da06aedda

- [x] MAJOR · `apps/web/src/components/agents/AgentPageView.tsx:225,363` (pre-fix) · The first cross-drive fix (`panesDriveId`) was only wired into the `AgentPanes` prop — two OTHER spots in the same file still assumed `page.driveId` equals the session's driveId: an optimistic SWR cache-key patch (silently wrong bucket) and the "Open in Agents" link builder (wrong console route). Both reachable in the same cross-drive-global scenario. Correct is: use the resolved session driveId at every site, not just one. — fixed in 57ce0b2ed (self-review, altitude pass)
- [x] MINOR · `apps/web/src/components/agents/AgentPageView.tsx` / `AgentsSurface.tsx` (pre-fix) · Near-identical session-record fetcher + useSWR call duplicated across two files, with drifted caching options (missing `revalidateOnFocus: false, dedupingInterval: 30_000` on the newer one). Correct is: one shared hook. — fixed in 57ce0b2ed (self-review, reuse+efficiency+simplification passes; 3/4 agents independently flagged it)
- [x] MINOR · `apps/web/src/components/agents/__tests__/AgentPageView.test.tsx` (pre-fix) · `mockUseSWR.mockReturnValue(...)` override in one test wasn't reset by `vi.clearAllMocks()` (doesn't revert persistent mock implementations) — silently leaked into every later test in the file. Correct is: reset in `beforeEach`. — fixed in 57ce0b2ed (self-review, simplification pass)

### Third pass — chatgpt-codex-connector re-review of 57ce0b2ed

- [x] MAJOR · `apps/web/src/components/agents/AgentsSurface.tsx:48` (pre-fix) · The shared-hook extraction's fallback (`sessionData?.session ? ... : storeDriveId`) returns `storeDriveId` (null on the global console route) while the session record is still unresolved — indistinguishable from a CONFIRMED global session. Since `AgentPanes` now treats `driveId === null` as "show every accessible agent," mounting the grid during that window could let a user pick a cross-drive agent that then 400s server-side. Reachable on every session selection from the global console not already SWR-cached. Correct is: track resolved-vs-not separately and don't mount the grid until known. — fixed in 357fbacbf (chatgpt-codex-connector, P2)

## Verified, no change needed
- Both production callers of `createConversationInSessionWith` (the `POST /api/ai/page-agents/[agentId]/conversations` route, and the `spawn_session` agent tool via `session-tools-runtime.ts`'s `createWorkerSession`) independently gate on per-agent view permission (`canPrincipalViewPage` / `canUseAgent`) before this path runs — relaxing the drive gate for global sessions does not bypass access control on either path.
- Billing/tenant resolution (`resolveSessionTenantId`/`resolveSessionPayerId`) is keyed on the SESSION's own `driveId`/`ownerId`, never the hosted agent's — a global session's sandbox always bills its owner regardless of which agent's conversation runs inside it.
- Drive content access is API-mediated per tool call (`canActorViewPage`/agent-permission checks), not filesystem-mounted to a session's drive — no content-safety concern from cross-drive hosting.

## Verdict
0 blockers / 0 majors / 0 minors / 0 nits outstanding; 8 fixed (1 blocker, 3 majors, 3 minors, 1 nit) across 3 review passes and 3 commits (da06aedda, 57ce0b2ed, 357fbacbf).
