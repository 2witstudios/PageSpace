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
