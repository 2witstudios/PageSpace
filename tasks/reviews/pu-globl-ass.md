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

## Verified, no change needed
- Both production callers of `createConversationInSessionWith` (the `POST /api/ai/page-agents/[agentId]/conversations` route, and the `spawn_session` agent tool via `session-tools-runtime.ts`'s `createWorkerSession`) independently gate on per-agent view permission (`canPrincipalViewPage` / `canUseAgent`) before this path runs — relaxing the drive gate for global sessions does not bypass access control on either path.
- Billing/tenant resolution (`resolveSessionTenantId`/`resolveSessionPayerId`) is keyed on the SESSION's own `driveId`/`ownerId`, never the hosted agent's — a global session's sandbox always bills its owner regardless of which agent's conversation runs inside it.
- Drive content access is API-mediated per tool call (`canActorViewPage`/agent-permission checks), not filesystem-mounted to a session's drive — no content-safety concern from cross-drive hosting.

## Verdict
0 blockers / 0 majors / 0 minors / 0 nits outstanding; 4 fixed (1 blocker, 1 major, 1 minor, 1 nit).
