# Deploy Safety — PR #2125 Review-Fix Follow-ups

Companion to the deploy-safety audit (`tasks/solo-tells-audit-2026-07-17.md` section 6) and
PR #2125 (`pu/staging-deploy`). Tracks fixes for CodeRabbit/Codex review findings that
survived the initial merge, triaged via `/aidd-pr`.

## Requirements

- Given a migration one-shot machine reaches Fly's `stopped` state with a non-zero
  `exit_event.exit_code` (e.g. the migration script itself errored), `run-fly-migration.sh`
  should treat it as a failure — destroy the machine, print the failure, and exit 1 — not
  print "Migrations complete" and exit 0.
