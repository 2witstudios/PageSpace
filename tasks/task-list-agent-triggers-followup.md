# Task List Agent Triggers Follow-up Epic

**Status**: 📋 PLANNED
**Goal**: Close the post-merge gaps from PR #1177 so per-task agent triggers feel "fully working" to a typical user.

## Overview

PR #1177 (squash-merged as `b853f3b74`) shipped per-task and page-level agent triggers on Task List pages, but a post-merge audit found that triggers are configurable from only one surface (the Task List page itself, not from `TaskDetailSheet` used by the dashboard / right sidebar / "my tasks"); that `broadcastTaskEvent` only fans out to the originating user's room, so collaborators do not see badge changes in real time; that the per-task dialog hides `instructionPageId` and `contextPageIds`, leaving humans with strictly less power than agents who set those fields via `update_task`'s `agentTrigger` parameter; and that minor wiring inconsistencies (mobile kebab vs kanban, dialog typing clobbered by remote refetches, gray-on-gray "error" status text, dead `metadata.hasTrigger`/`metadata.triggerTypes` on the `TaskItem` TS type) accumulated through the late-stage refactor that extracted `recomputeTaskTriggerMetadata`. This epic addresses those gaps without expanding scope to cross-list moves, run-history UI, or trigger-error toasts.

---

## Polish and correctness pass

Tighten the post-refactor edges: gate the mobile kebab "Agent triggers…" item like kanban does, register the per-task dialog with `useEditingStore` while open, color `lastRunStatus === 'error'` with `text-destructive`, and drop the now-unread `hasTrigger` / `triggerTypes` fields from `TaskItem.metadata` in `task-list-types.ts`.

**Requirements**:
- Given a remote `task_updated` broadcast arrives while the trigger dialog is open with unsaved prompt text, should preserve the in-progress text rather than refetching and clobbering it.
- Given a workflow row with `lastRunStatus = 'error'` shown in the dialog, should signal the failure visually (not blend in with neutral muted text) so users notice broken triggers.
- Given a `MobileTaskCard` rendered without an `onConfigureTriggers` handler, should hide the kebab item rather than throw on click.

---

## Page-scoped task broadcast

Make `broadcastTaskEvent` fan out to a `pageId`-scoped room in addition to `user:${userId}:tasks` when `payload.pageId` is set, and fix `TaskListView`'s client emit from the unhandled `join_page` to the existing access-checked `join_channel` handler so its socket actually joins that page room.

**Requirements**:
- Given two users open the same Task List page and User A configures a trigger, should make User B's bell badge appear without a manual refresh.
- Given the existing `update_task` AI tool path, should continue to deliver task events to the originator's other tabs without regression after the broadcast becomes dual-channel.
- Given a client socket that has not been granted view access to a page, should not receive that page's task events even after the dual-channel broadcast lands.

---

## Agent parity in trigger dialog

Add an "Advanced" collapsible section to each trigger pane in `TaskAgentTriggersDialog` exposing an instruction-page picker and a context-pages multi-picker (capped at 10 to match the Zod schema), plumb both through the `SectionState` shape into the existing PUT body, and relax dialog-side validation so `prompt` is optional once `instructionPageId` is set.

**Requirements**:
- Given an agent that previously created a trigger with `instructionPageId` and `contextPageIds` via `update_task`, should let a human user open the dialog, see those values, and edit or clear them without losing the rest of the trigger config.
- Given a user who selects an instruction page and leaves the prompt empty, should accept and save the trigger (matching the helper-level "either prompt or instructionPageId" rule), rather than block on a prompt-required validation.
- Given a user picking context pages, should not allow more than 10 entries and should not allow pages from a different drive than the task list.

---

## Workflows anchored-to clarity

In the page-level Workflows dialog (`TaskListWorkflowsDialog` + `WorkflowForm`), surface a small "Anchored to: [taskListTitle]" badge plus read-only chips for any non-anchor `contextPageIds`, so users understand the scope of a workflow before editing it.

**Requirements**:
- Given a workflow whose `contextPageIds` includes other pages alongside the task list page, should make those additional context pages visible (without requiring edit) so the user is not surprised when the agent runs with that wider context.
- Given the auto-anchor behavior that adds the task list page to `contextPageIds` on every save, should communicate that the relationship exists rather than appearing as an opaque magic field.

---

## Trigger discoverability in TaskDetailSheet

Wire the same trigger UI into `apps/web/src/components/tasks/TaskDetailSheet.tsx` (the dashboard / right-sidebar / "my tasks" surface) by reusing `TaskAgentTriggersDialog` directly: a `Bell` badge when `task.activeTriggerCount > 0`, an "Agent triggers…" entry, and pass-through of `pageId` / `driveId` from the sheet's caller.

**Requirements**:
- Given a user clicks a task from the dashboard or right sidebar, should let them configure triggers from that surface end-to-end without first navigating to the source Task List page.
- Given a viewer-only user opens the same sheet, should show neither the badge nor the trigger entry, mirroring the row-level gate on the Task List page.
- Given a saved trigger in the sheet, should make the bell badge appear consistently on both the sheet and the corresponding row in the source Task List page.

---
