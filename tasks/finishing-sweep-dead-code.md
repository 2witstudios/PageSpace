# Finishing Sweep: Dead-Code Deletion Backlog Epic

**Status**: PLANNED
**Goal**: Triage every `bun run knip` finding into DELETE or KEEP-WITH-DOCUMENTED-REASON and land the deletions before any CI baseline snapshot freezes the current backlog.

## Overview

WHY the repo's own dead-code tool reports ~99 unused files, 55 unused deps, and 222+141 unused exports/types that nothing ever deletes, and a sibling "knip-ci" effort is expected to turn `knip` into a blocking CI gate via a baseline snapshot that would otherwise permanently codify today's ~16,000 LOC of dead code as acceptable; full cluster-by-cluster verification evidence (file:line grep results, LOC tallies, and the false positives found along the way) lives in the backing plan at `.claude/plans/reflective-scribbling-valley.md`. Explicitly out of scope for this epic: the long tail of unused exports/types (dominated by `packages/db/src/schema/*Relations` Drizzle-relation false positives) and the 31 duplicate-exports (an intentional `default`+named convention) — both need their own follow-up once Task 1's config pass makes the real signal visible.

---

## Knip Config Accuracy Pass

Fix `knip.json` so it stops flagging live code as dead and document every genuine false positive inline.

**Requirements**:
- Given `packages/cli`'s `bin.ts`/`bin-pagespace-mcp.ts` and `packages/db`'s `migrate-pending-invites.ts` are real `package.json` entrypoints knip can't resolve, should add workspace `entry` config for them rather than deleting them
- Given `platform-storage/{desktop,ios,web}-storage.ts` are dispatched via dynamic `require()` inside `getPlatformStorage()`, should add them to knip ignores rather than deleting live auth-storage code that desktop/iOS depend on
- Given `next-server-stub.ts` and `mock-server-main.ts` are resolved via a vitest `resolve.alias` and a Playwright `webServer` command respectively (not static imports), should add knip ignores for both
- Given `TenantProvisioningCompleteEmail.tsx` is a built-but-unwired template already tracked by the solo-tells audit's onboarding-gap finding, should document it as an intentional KEEP with a comment pointing at that finding, not delete it
- Given `knip.json` has no comment syntax, should convert it to `knip.jsonc` so each ignore carries its KEEP rationale next to it
- Given this PR touches zero application code, should land first and before any knip-ci baseline snapshot is taken

---

## Delete Dead AI Elements Kit Files

Prune the vendored AI Elements kit down to the 3 files actually in use.

**Requirements**:
- Given `apps/web/src/components/ai/ui/conversation.tsx`, `tool.tsx`, and `code-block.tsx` are imported by `ChatMessagesArea`, `ToolRunGroup`/`ToolCallRenderer`, and `DocumentRenderer` respectively, should keep all three in place
- Given the other 26 files in that directory plus `__tests__/sanitize-iframe-src.test.ts` (which only exercises the otherwise-dead `web-preview.tsx`) have zero production references, should delete all 27 (~5,681 LOC)
- Given this is a pure deletion, should verify `bun run typecheck` and `bun run test:unit` stay green before merge

---

## Delete Dead Integrations Cluster

Remove the never-wired ToolBuilder/OpenAPIImportDialog/JsonSchemaBuilder trio and its orphaned backing routes.

**Requirements**:
- Given `ToolBuilder.tsx`, `OpenAPIImportDialog.tsx`, and `JsonSchemaBuilder.tsx` were added whole in a single commit (#693) and never wired into any live settings/admin page, should delete all three (652 LOC)
- Given `api/integrations/providers/[providerId]/route.ts` (PUT/DELETE) and `api/integrations/providers/import-openapi/route.ts` have no caller other than the dead trio, should delete both routes alongside it (236 LOC)

---

## Delete Dead Version-History UI and Orphaned Compare API

Remove the pre-rewrite version-history UI while preserving the one component from that folder that's still live.

**Requirements**:
- Given `RollbackConfirmDialog.tsx` is actively imported by `ActivityItem.tsx` and `SidebarActivityTab.tsx`, should relocate it into `components/activity/` before deleting the rest of `components/version-history/`
- Given `VersionHistoryPanel.tsx`, `VersionHistoryItem.tsx`, and the `api/pages/[pageId]/versions/compare` route + its test have zero callers, and the rollback service's revert-to-point model does not supersede or call the compare/diff logic, should delete all four (~1,349 LOC combined) and remove that route's line from the exemption list in `security-audit-coverage.test.ts`
- Given other active worktrees may be mid-edit on `ActivityItem.tsx`/`SidebarActivityTab.tsx`, should check `gh pr list` for conflicts before merging

---

## Delete Unused useDirectUpload Hook

**Requirements**:
- Given every real upload call site (`FilesEmptyState`, `QuickCreatePalette`, `useFileDrop`) calls `uploadFileToS3` directly and none import the hook, should delete `apps/web/src/hooks/useDirectUpload.ts` (63 LOC)

---

## Delete Unused Marketing Shadcn Files

Prune apps/marketing's unused shadcn primitives, including files only kept alive by other dead files.

**Requirements**:
- Given 45 of 56 files under `apps/marketing/src/components/ui/` have zero importers — including transitively-dead files only referenced by other dead files, e.g. `sidebar.tsx` drags down `skeleton.tsx`/`tooltip.tsx` — should delete all 45 (~5,869 LOC)
- Given a UI-primitive deletion this size needs a stronger regression signal than typecheck alone, should additionally run `bun run build` scoped to apps/marketing before merging

---

## Delete Knip-Surfaced Dead File Batch

Clear the remaining single-file dead code knip found outside the 8 named clusters.

**Requirements**:
- Given `global-prompt.ts`, `DriveList.tsx`, `workspace-selector.tsx`, `SidebarSettingsTab.tsx`, `AuthButtons.tsx`, `ContactForm.tsx` (apps/web), `task-hooks.ts`, `TaskMobileCard.tsx`, and the `lib/repositories/index.ts` / `lib/tabs/index.ts` / control-plane `repositories/index.ts` barrels have zero importers even by dynamic-import grep, should delete all eleven (~2,158 LOC)
- Given `apps/web/src/components/shared/AuthButtons.tsx` is superseded by the live `components/auth/OAuthButtons.tsx` used by signin/signup, should confirm that live component is untouched by this deletion

---

## Dependency Ledger Cleanup

Reconcile every workspace's package.json against knip's dependency findings.

**Requirements**:
- Given knip confirms 55 unused deps, 11 unused devDeps, and 24 unlisted-but-actually-used deps across every workspace, should remove the former and explicitly declare the latter (notably `server-only` in 8 apps/web files and `drizzle-orm`/`pg` in several `scripts/*` files)
- Given `@ai-sdk/anthropic`/`google`/`openai`/`xai` are orphaned from the abandoned AI SDK 7 migration while `@ai-sdk/openai-compatible` (local/on-prem providers) and `@ai-sdk/react` remain live, should remove only the first four from `apps/web/package.json`
- Given removing a dependency before its last consumer file is deleted can mask which change actually broke a build, should land this task after the AI Elements and marketing shadcn deletions

---

## Consolidate MessageRenderer and CompactMessageRenderer

Extract the duplicated stateful logic between the two real, still-needed chat renderers instead of deleting either.

**Requirements**:
- Given both components are actively used (main chat vs. right-sidebar chat) and ~162 of 946 combined lines differ, should extract the duplicated todo-list socket wiring, edit/delete/retry handlers, and grouped-parts switch into a shared hook rather than deleting either file
- Given the compact renderer has no `isHighlighted`/`isCurrentMatch` support because the sidebar has no find-in-conversation feature, should document that gap explicitly rather than silently adding or dropping the behavior as a side effect of this refactor
- Given this touches live chat UI, should manually smoke-test both the main AI chat view and the right-sidebar AI assistant tab before merging

---

## Archive Confirmed One-Shot Migration Scripts

Ledger the scripts/ directory rather than blanket-deleting it — an unrun migration script is a data-correctness risk, not just dead code.

**Requirements**:
- Given `backfill-user-pii-encryption.ts` is confirmed run in prod (2026-07-06 per `tasks/pii-decrypt-perf-remediation-round2.md`) and most `fix-*`/`migrate-*` codemods in `scripts/` have no remaining un-migrated targets, should delete those alongside their `lib/*-backfill.ts`/`lib/*-verb-tools.ts` helpers
- Given `backfill-legacy-ciphertext-reencrypt.ts` and `backfill-audit-db.ts` (8 days old) are code-complete but not confirmed executed in prod, should hold both for explicit owner go/no-go rather than deleting on knip evidence alone
- Given `package.json`'s `changelog:generate` script points at a deleted `scripts/changelog/` directory, should fix or remove that entry and delete the correspondingly-broken `changelog-shell-safety.test.ts` and the dead `tenant-*`/`changelog-*` globs in `scripts/vitest.config.ts`
- Given `send-sdk-launch-notifications.ts` and `lib/sdk-launch-broadcast.ts` are 3 days old, should leave both untouched pending more runway to judge whether they're one-shot or recurring

---
