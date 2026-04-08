# Security Alert Triage — Batch 7: Incomplete Sanitization in Changelog Scripts

## Summary

4 CodeQL `js/incomplete-sanitization` (CWE-116) HIGH alerts in changelog analysis scripts. All 4 flag the same pattern: `.replace(/\|/g, "\\|")` escapes pipe characters for markdown table cells but does not escape backslashes. All rated **S3 — Dismiss** because the output is markdown documentation files (display only), not RegExp, shell exec, or SQL.

## Alert #132 — js/incomplete-sanitization
- **File**: `scripts/changelog/detect-abandoned-approaches.ts:192`
- **Rating**: S3 — False Positive / Low Priority
- **Rationale**: `file.created.message` from `git log --diff-filter=A --format="COMMIT:%H|%ad|%s"` is escaped with `.replace(/\|/g, "\\|")` and inserted into a markdown table. Output written to `docs/changelog/evidence/patterns/abandoned-approaches.md`. No code execution path from this output — it is static documentation. Input is semi-trusted (git commit subjects, requires commit access to the repository).
- **Action**: Dismiss — "S3: Developer tooling script. Output is markdown documentation only. No code execution path. Input is git commit subjects."

## Alert #133 — js/incomplete-sanitization
- **File**: `scripts/changelog/detect-abandoned-approaches.ts:193`
- **Rating**: S3 — False Positive / Low Priority
- **Rationale**: Same pattern as #132 on adjacent line, using `file.deleted.message` from `git log --diff-filter=D`. Same output destination, same risk profile.
- **Action**: Dismiss — same rationale as #132.

## Alert #134 — js/incomplete-sanitization
- **File**: `scripts/changelog/detect-multiple-attempts.ts:219`
- **Rating**: S3 — False Positive / Low Priority
- **Rationale**: `commit.subject` from `git log --format="COMMIT:%H|%ad|%s|BODY_START%b|BODY_END"` is escaped with `.slice(0, 60).replace(/\|/g, "\\|")` and inserted into a markdown table. Output written to `docs/changelog/evidence/patterns/multiple-attempts.md`. Developer tooling only — not referenced in CI or production builds.
- **Action**: Dismiss — "S3: Developer tooling script. Output is markdown documentation only. No code execution path."

## Alert #135 — js/incomplete-sanitization
- **File**: `scripts/changelog/track-file-evolution.ts:174`
- **Rating**: S3 — False Positive / Low Priority
- **Rationale**: `commit.message` from `git log --follow --format="COMMIT:%H|%ad|%s"` is escaped with `.replace(/\|/g, "\\|").slice(0, 60)` and inserted into a markdown table. Output written to `docs/changelog/evidence/files/<filename>.md`. Static documentation output with no downstream parsing or execution.
- **Action**: Dismiss — "S3: Developer tooling script. Output is markdown documentation only. No code execution path."

## Precedent

Alert #28 (`prettier.ts:57`) was the same CWE-116 incomplete-sanitization rule but was rated S2 and FIXED because the incompletely-escaped string was passed to `new RegExp()`, where backslashes alter regex semantics. These 4 alerts output exclusively to static `.md` files — no interpreter processes the output.
