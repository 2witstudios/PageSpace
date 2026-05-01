# Workflow Trigger Decomposition Epic

**Status**: 📋 IN PROGRESS — combined PR 1 in flight
**Goal**: Split `workflows` into a pure execution-definition table with per-domain trigger tables (`taskTriggers`, `calendarTriggers`) referencing it, and a unified `workflow_runs` audit table — so one agent can be reused across N triggers and one new trigger source no longer requires another nullable FK on `workflows`.

## Overview

The current `workflows` table conflates trigger config (taskItemId, task-flavored triggerType enum values, cronExpression, eventTriggers, nextRunAt) with execution payload (prompt, agentPageId, instructionPageId, contextPageIds), so adding a new trigger source means another nullable column and another enum case, and one agent definition cannot be reused across multiple triggers without duplicating its execution row. `calendarTriggers` already split out as a peer table but inverted the mistake — it correctly separates "when" from "what" yet duplicates the execution-payload columns on its own schema and papers over that with a synthetic-WorkflowRow hack inside `calendar-trigger-executor.ts`. This epic resolves both: workflows becomes a pure execution definition, taskTriggers becomes a peer of calendarTriggers (both holding workflowId FK only, no payload columns), `executeWorkflow()` accepts a typed `WorkflowExecutionInput` instead of a literal row, and `workflow_runs` replaces the overwritten `lastRun*` fields plus the per-fire state currently living on calendarTriggers — yielding one unified history surface. None of these tables hold meaningful prod data yet, so every migration is a hard cutover with no bridge columns, no dual-write, no backfill.

---

## Decompose workflows: schema split + executor refactor + per-domain triggers

Combined task: drop task-specific columns/enum values from `workflows`; introduce `taskTriggers` (`workflowId` FK + `taskItemId` + `triggerType ('due_date'|'completion')` + scheduling fields); add `workflowId` FK to `calendarTriggers` and drop its duplicated payload columns; refactor `executeWorkflow()` to accept a typed `WorkflowExecutionInput` (not a literal `WorkflowRow`); delete the synthetic-row construction in `calendar-trigger-executor.ts`; rewire all callers (helpers, cron pollers, REST APIs, AI tools) to the new shape. One migration, one coherent diff.

**Requirements**:
- Given an empty database, applying the migration should drop `workflows.taskItemId`, drop the `task_due_date` and `task_completion` enum values from `workflowTriggerType`, create the `taskTriggers` table, add `calendarTriggers.workflowId` (NOT NULL FK, cascade), and drop `calendarTriggers.{prompt, agentPageId, instructionPageId, contextPageIds}` — all in a single migration with no nullable bridge column.
- Given the existing UI flow that creates a task trigger, the API endpoint should produce one `workflows` row (execution) and one `taskTriggers` row (when) atomically in a transaction.
- Given the AI agent's `update_task` tool with an `agentTrigger` payload, the helper path should write the same split shape as the UI route and not insert directly into the DB.
- Given a calendar event being created with an `agentTrigger` payload (REST or AI tool), the handler should write one `workflows` row and one `calendarTriggers` row atomically.
- Given a task whose `dueDate` is updated, `syncTaskDueDateTrigger` should mutate `taskTriggers.nextRunAt` (not `workflows.nextRunAt`) and only when `lastFiredAt IS NULL`.
- Given a task moving into a "done" status group, `fireCompletionTrigger` should atomically claim the matching `taskTriggers` row (one fire per row, ever), execute the linked workflow, then write `lastFiredAt` and `isEnabled=false`.
- Given the cron workflows poller runs, it should query only `triggerType='cron'` workflows and never touch task-flavored rows (which no longer exist).
- Given the new cron task-triggers poller runs, it should pick `taskTriggers` rows where `isEnabled=true AND nextRunAt <= NOW() AND lastFiredAt IS NULL`, claim atomically, execute, and write back.
- Given a deleted task, both its `taskTriggers` row and its linked `workflows` row should be removed (cascade or explicit delete in `disableTaskTriggers` — pick one, document why in commit).
- Given `executeWorkflow()` after refactor, it should accept `WorkflowExecutionInput` (the minimum execution-relevant shape) and not depend on a literal `workflows` table row, so any caller can compose the input without forging fake rows.
- Given the calendar trigger executor after refactor, it should load the linked `workflows` row by `calendarTriggers.workflowId` and call `executeWorkflow()` with composed input — no synthetic-WorkflowRow construction remains in the file.
- Given the cron, manual-fire (`/run`), task-completion, and task-due-date callers, all should pass `WorkflowExecutionInput` instead of `WorkflowRow`.
- Given the test suite runs after the change, every existing task-trigger and calendar-trigger test should pass against the new schema (no skipped tests).

---

## Add workflow_runs and retire lastRun*

Introduce `workflow_runs` as the canonical per-fire audit table; drop `lastRunAt` / `lastRunStatus` / `lastRunError` / `lastRunDurationMs` from `workflows`; drop the per-fire state columns (`status`, `claimedAt`, `startedAt`, `completedAt`, `error`, `durationMs`, `conversationId`) from `calendarTriggers`. Every workflow execution writes one row to `workflow_runs` at start (status='running') and updates it at end (status='success'|'error', endedAt, durationMs, error, conversationId). Cron pollers, manual-fire, task-trigger fires, and calendar-trigger fires all write through `workflow_runs`.

**Requirements**:
- Given an empty database, the migration should create `workflow_runs` with `(workflowId, sourceTable, sourceId, triggerAt, startedAt, endedAt, status, error, durationMs, conversationId)` and drop the eleven columns above from their current homes in a single migration.
- Given any workflow execution path (cron / task / calendar / manual), exactly one new row should appear in `workflow_runs` per fire, with `sourceTable` set to the originating trigger table or `'cron'`/`'manual'`.
- Given a stuck-run cleanup sweep, it should mark `workflow_runs` rows in `status='running'` for >10 minutes as `status='error'` with an explanatory error message; trigger-table state is no longer involved in stuck-run detection.
- Given the workflows UI dashboard, "last run" status should be derived from a join on `workflow_runs` ordered by `startedAt DESC`, not from columns on `workflows`.
- Given a workflow with N successful fires, `SELECT COUNT(*) FROM workflow_runs WHERE workflow_id = X` should return N.
- Given the calendar-triggers cron poller, "find unfired triggers" should be expressed as `calendarTriggers` rows where `triggerAt <= NOW()` AND no `workflow_runs` row exists with `(sourceTable='calendarTriggers', sourceId=calendarTriggers.id, status IN ('running','success'))` — verify the EXPLAIN plan is acceptable; add an index if needed.
