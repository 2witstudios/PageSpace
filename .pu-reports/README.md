# Agent reports

Every agent on this epic writes its report here and commits it, rather than
leaving it in the transcript.

Three failures made this a rule instead of a preference:
- reviewer findings were destroyed by TUI redraw churn in the log byte-tail,
  and a completed review's findings became unrecoverable;
- agents finished work and stopped without committing it, three times;
- `pu status` reports "running" indefinitely, and log-hash stability gives
  false positives during long thinking pauses, so neither is a completion signal.

A committed file solves all three at once: the finding outlives the transcript,
the commit proves the work landed, and its existence is a completion signal the
orchestrator can poll on the filesystem.

## What these reports are, and what they are not (2026-08-09)

**They are dated findings, not current documentation.** Each was accurate when
it was written and is left as written — correcting one after the fact would
destroy the record it exists to keep. Where a report and the branch disagree,
**the branch is authoritative.**

One disagreement is large enough to name here, because reviewers have twice
raised findings against reports rather than against source:

**Migration `0256` is NOT in this release.** Many reports below describe a
cutover in which `0255` (the additive node tables) and `0256` (dropping the old
pane-grid tables and `conversations.workspaceId` / `closedInWorkspaceAt`) ship
together, with a documented five-step rollout that runs the backfill between
them. That rollout cannot happen: `packages/db/src/migrate.ts` loads the whole
journal and `runMigrations` applies every pending migration in ONE invocation,
so the two were never two deploys. `0256` would have run immediately after
`0255`, before the backfill could execute, and its pre-flight would have failed
the migrate one-shot on every existing database with live workspace data.

So `0256` is unregistered and deferred to a follow-up PR that ships after the
backfill has run, and the old tables and columns are restored — inert, written
by nothing, and explicitly excluded-with-reason in the tenant export and the
GDPR export coverage registries until the drop.

`0255` was also regenerated (`0255_clear_phil_sheldon.sql`, replacing
`0255_boring_leo.sql`) to make its root CHECK biconditional, so reports naming
the old filename are naming a file that no longer exists.

Read these for the REASONING — which findings were real, what was mutation-checked,
and why a decision went the way it did. Read the branch for the state.
