# Changelog Audit Guide

> How to verify any claim in the changelog with evidence

This document explains the evidence-based changelog system and how to verify any claim made in the era documents.

## Evidence System Overview

The PageSpace changelog uses a **three-layer evidence system**:

### Layer 1: Evidence Index (`evidence/evidence-index.json`)

A machine-generated JSON database containing raw facts from git history:

- **File Lifecycles**: When every file was created, modified, and deleted
- **Abandoned Approaches**: Files created then deleted (failed experiments)
- **Multiple Attempts**: Commits showing retry patterns
- **Candid Messages**: Developer emotions in commit messages
- **Most Churned Files**: Files with highest modification frequency

### Layer 2: Pattern Documents (`evidence/patterns/`)

Human-readable summaries of patterns found:

| Document | Contents |
|----------|----------|
| `abandoned-approaches.md` | Files created then deleted, categorized by reason |
| `multiple-attempts.md` | Features that took multiple tries |
| `candid-messages.md` | Commits with honest developer commentary |

### Layer 3: File Evolution Documents (`evidence/files/`)

Per-file histories showing:

- Size evolution over time (lines added/removed per commit)
- Notable patterns (large changes, pivots)
- Candid developer notes
- Verification commands

## Regenerating Evidence

To regenerate all evidence from current git history:

```bash
pnpm changelog:generate
```

This runs all evidence generation scripts and updates:
- `evidence/evidence-index.json`
- `evidence/file-index.md`
- `evidence/files/*.md`
- `evidence/patterns/*.md`

## Verification Commands

### Find When a File Was Created

```bash
git log --diff-filter=A --format="%H %ad %s" --date=short -- "path/to/file"
```

### Find When a File Was Deleted

```bash
git log --diff-filter=D --format="%H %ad %s" --date=short -- "path/to/file"
```

### View File Content at Any Point

```bash
# View file at specific commit
git show <commit>:"path/to/file"

# View file before deletion (parent of delete commit)
git show <delete-commit>^:"path/to/file"
```

### Find Commits with Specific Messages

```bash
# Find commits mentioning "broken"
git log --grep="broken" --oneline -i

# Find commits with candid messages
git log --grep="lol\|hack\|workaround\|finally" --oneline -i --extended-regexp

# Find multiple attempt patterns
git log --grep="again\|retry\|finally" --oneline -i --extended-regexp
```

### File Churn Analysis

```bash
# Most frequently modified files
git log --format= --name-only | sort | uniq -c | sort -rn | head -50

# Changes per file in date range
git log --since="2025-09-01" --until="2025-10-01" --format= --name-only | sort | uniq -c | sort -rn
```

### Abandoned Approaches

```bash
# Files that were deleted
git log --diff-filter=D --format="%ad|%s" --date=short --name-only | head -100

# Files created and deleted (compare with created files)
git log --diff-filter=A --format="%H|%ad|%s" --date=short --name-only
```

## Verifying Specific Claims

### "Feature X was implemented in Era Y"

1. Find the era's date range in `README.md`
2. Search for commits in that range:
   ```bash
   git log --since="2025-09-19" --until="2025-09-30" --oneline --grep="feature"
   ```
3. Cross-reference with `evidence-index.json` file lifecycles

### "Architecture shifted from A to B"

1. Check `evidence/patterns/abandoned-approaches.md` for deleted files
2. Look for file evolution documents showing the transition
3. Verify with git log for rename/move operations:
   ```bash
   git log --diff-filter=R --summary
   ```

### "This approach was tried and abandoned"

1. Check `evidence/patterns/abandoned-approaches.md`
2. Find the specific file in `evidence/evidence-index.json` under `fileLifecycles`
3. Verify with:
   ```bash
   git log --follow --stat -- "path/to/abandoned/file"
   ```

### "Feature took multiple attempts"

1. Check `evidence/patterns/multiple-attempts.md`
2. Find related files in `evidence/files/` for detailed history
3. Verify with commit message search:
   ```bash
   git log --grep="again\|retry\|attempt" --oneline | grep -i "feature-name"
   ```

## Evidence Generation Scripts

Located in `scripts/changelog/`:

| Script | Purpose | Output |
|--------|---------|--------|
| `index.ts` | Master runner | All outputs |
| `generate-evidence-index.ts` | Main evidence database | `evidence-index.json` |
| `detect-abandoned-approaches.ts` | Find deleted experiments | `patterns/abandoned-approaches.md` |
| `detect-multiple-attempts.ts` | Find retry patterns | `patterns/multiple-attempts.md`, `patterns/candid-messages.md` |
| `track-file-evolution.ts` | Per-file histories | `files/*.md`, `file-index.md` |

## Understanding the Evidence Index

The `evidence-index.json` structure:

```typescript
interface EvidenceIndex {
  generated: string;              // Timestamp
  totalCommits: number;           // Total commits analyzed
  totalFilesTracked: number;      // Unique files touched

  fileLifecycles: {
    [path: string]: {
      path: string;
      created?: { commit, date, message };
      deleted?: { commit, date, message };
      modifications: number;
      events: Array<{ commit, date, message, action }>;
    }
  };

  abandonedApproaches: Array<{
    file: string;
    created: { commit, date, message };
    deleted: { commit, date, message };
    daysActive: number;
  }>;

  multipleAttempts: Array<{
    pattern: string;              // Regex pattern matched
    commits: Array<{ commit, date, message, filesChanged }>;
  }>;

  candidMessages: Array<{
    commit: string;
    date: string;
    message: string;
    keywords: string[];           // Patterns matched (lol, hack, etc.)
  }>;

  mostChurnedFiles: Array<{
    path: string;
    modifications: number;
  }>;
}
```

## Adding Evidence to Era Documents

When writing era documents, include evidence sections:

```markdown
## Evidence

### Architecture Changes
- [File evolution: auth route](./evidence/files/apps-web-src-app-api-auth-route.ts.md)
- See `abandoned-approaches.md` for discarded authentication methods

### What Didn't Work
- **OAuth2 Direct Integration** (Sep 14-16): Attempted custom OAuth2 flow,
  abandoned for simpler JWT approach. See commit `abc1234`.
- **Session-based Auth** (Sep 12): Tried traditional sessions, moved to
  stateless JWT for mobile support.

### Verification
```bash
# Verify authentication evolution
git log --oneline --since="2025-09-10" --until="2025-09-20" -- "apps/web/src/app/api/auth/"
```
```

## Maintaining Evidence Integrity

1. **Regenerate periodically**: Run `pnpm changelog:generate` after major development phases
2. **Cross-reference claims**: Every architectural claim should link to evidence
3. **Document what didn't work**: Failed approaches are as valuable as successes
4. **Keep candid messages**: Don't sanitize commit history - honesty aids understanding

## Troubleshooting

### Evidence generation fails

```bash
# Check git history is accessible
git log --oneline -10

# Ensure tsx is available
pnpm exec tsx --version
```

### File not found in evidence

The file may have been:
- Created after evidence was generated (regenerate)
- Part of pre-genesis history (check different repos)
- In ignored paths (node_modules, .next, etc.)

### Dates don't match era documents

Era documents group by theme, not strict dates. Use git log with date ranges to verify actual commit dates:

```bash
git log --format="%ad %s" --date=short | sort | uniq
```

---

*Last updated: 2026-01-22*
