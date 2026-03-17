# Data Migration Tooling Epic

**Status**: PLANNED
**Goal**: Scripts to export a team's data from the shared SaaS instance and import into their isolated tenant

## Overview

When a team upgrades to isolated infrastructure, their existing data (drives, pages, messages, files, permissions) needs to move from the shared database to their new tenant's database. Because PageSpace uses cuid2 for all IDs (globally unique), we can preserve IDs during migration with zero collision risk. This epic builds the export/import pipeline and a runbook for the cutover process.

**Dependencies**: Epic 5 (target tenant instance exists)

---

## Standards & Rules

Read and follow these before writing any code. They apply to every task in this epic.

- **TDD Process** (`.claude/rules/tdd.mdc`): Write the test FIRST. Run it. Watch it fail. Then implement ONLY the code needed to make it pass. Repeat for each requirement. Do not write implementation before tests.
- **Test Rubric** (`.pu/templates/rubric-review.md`): Score each test file against the rubric before committing. Tests must be contract-first, mock only at boundaries, and assert observable outcomes.
- **Deferred Work Policy** (`.claude/rules/deferred-work-policy.mdc`): Complete all requirements. Update this plan if you deviate. No silent substitutions.
- **Commit Convention** (`.claude/rules/commit.mdc`): Use conventional commits (`feat:`, `fix:`, `test:`, `chore:`).
- **Pre-Merge Audit** (`.claude/rules/pre-merge-audit.mdc`): Before opening a PR, audit every requirement in this plan against your diff.

**Note on test approach**: The export script's TDD approach mentions using a test database seeded with known data. Per the rubric, this is correct — migration correctness (joins, FK handling, row counts) must be validated against a real DB, not mocked. Use a separate test database (`pagespace_test`) and seed it in test setup. These are integration tests, not unit tests, and should be labeled clearly.

---

## Export Script

Create a script that exports a team's complete data from the shared instance.

**Requirements**:
- Given `scripts/tenant-export.ts --users user1,user2,user3 --output ./export-bundle/`, should export all data owned by those users
- Given the user list, should discover all drives where any user is a member
- Given the drives, should export: drive records, drive memberships, drive invitations, all pages (including nested tree structure), all messages and message parts, all files and file metadata, all permissions and access records
- Given file blobs, should copy referenced files from `FILE_STORAGE_PATH` into the export bundle
- Given the export, should produce: `data.sql` (INSERT statements preserving cuid2 IDs), `files/` directory with blobs, `manifest.json` (row counts per table, file checksums, export timestamp)
- Given a table with FK references to non-exported data, should handle gracefully (null out or skip orphaned refs)
- Given large datasets, should stream exports (not load entire tables into memory)

**TDD Approach**:
- Write export tests (`scripts/__tests__/tenant-export.test.ts`)
- Use a test database seeded with known data
- Given 2 users with 1 shared drive, should export exactly the rows belonging to those users/drives
- Given a page tree (parent/child), should export all levels maintaining parent references
- Given the manifest, should have correct row counts matching actual exported rows
- Given file references in pages, should copy all referenced files to the bundle
- Given a user who is member of a drive with non-exported users, should export the drive but only the listed users' memberships

---

## Import Script

Create a script that imports an export bundle into a fresh tenant database.

**Requirements**:
- Given `scripts/tenant-import.ts --input ./export-bundle/ --database-url postgresql://...`, should import all data
- Given the target database, should have empty tables (post-migration schema, no data)
- Given the SQL inserts, should execute in FK-dependency order (drives before pages, pages before messages)
- Given file blobs, should copy from bundle to the tenant's `FILE_STORAGE_PATH`
- Given the manifest, should validate row counts after import match expected counts
- Given duplicate IDs (re-run), should skip existing rows (idempotent) or use `ON CONFLICT DO NOTHING`
- Given FK validation post-import, should verify all foreign key references are satisfied

**TDD Approach**:
- Write import tests (`scripts/__tests__/tenant-import.test.ts`)
- Use a test database with fresh schema
- Given a valid export bundle, should import all rows and verify counts match manifest
- Given file blobs in the bundle, should exist at the target storage path after import
- Given re-running import on same data, should not create duplicates
- Given a corrupted manifest (wrong checksums), should warn but continue with option to abort

---

## Migration Integrity Validator

Create a post-migration validation tool.

**Requirements**:
- Given `scripts/tenant-validate.ts --source-url ... --target-url ... --users user1,user2`, should compare source and target data
- Given the comparison, should verify: row counts per table match, all cuid2 IDs from export exist in target, file blob checksums match
- Given discrepancies, should output a detailed report listing missing/mismatched records
- Given all checks pass, should output "Migration validated successfully"

**TDD Approach**:
- Write validation tests (`scripts/__tests__/tenant-validate.test.ts`)
- Given matching source and target, should report success
- Given target missing 1 page, should report the missing page ID
- Given file checksum mismatch, should report the affected file

---

## Cutover Runbook

Document the step-by-step cutover process.

**Requirements**:
- Given a team being migrated, should document: flag team users read-only on shared instance, run final export, import into tenant, validate integrity, switch DNS, notify users, soft-delete from shared after 30-day grace
- Given the runbook, should include rollback steps at each stage
- Given the 30-day grace period, should describe the cleanup script that removes soft-deleted data
- Given the read-only flag, should describe how to set it (API endpoint or direct DB update)

**TDD Approach**:
- Write a runbook validation test (`scripts/__tests__/cutover-runbook.test.ts`) that asserts the markdown file exists and contains key sections
- Given the runbook file, should contain sections: "Pre-migration", "Export", "Import", "Validate", "DNS Switch", "Rollback", "Cleanup"
