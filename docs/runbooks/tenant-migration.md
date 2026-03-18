# Tenant Data Migration Runbook

Step-by-step procedure for migrating a team from the shared PageSpace SaaS instance to their own isolated tenant infrastructure.

## Prerequisites

- Target tenant instance provisioned (Epic 5/6) and reachable
- Target database has schema applied (`pnpm db:migrate`)
- Target file storage directory exists and is writable
- Export/import scripts available: `scripts/tenant-export.ts`, `scripts/tenant-import.ts`, `scripts/tenant-validate.ts`
- List of user IDs to migrate (cuid2 IDs from the shared database)
- Maintenance window agreed with the team

---

## Pre-migration

1. **Notify the team** that a migration is scheduled. Provide the maintenance window and expected downtime.

2. **Verify user list** — confirm all user IDs are correct:
   ```sql
   SELECT id, name, email FROM users WHERE id IN ('user1', 'user2', ...);
   ```

3. **Check data volume** — run a dry-run export to estimate size:
   ```bash
   tsx scripts/tenant-export.ts \
     --users user1,user2 \
     --output /tmp/migration-dryrun \
     --dry-run
   ```

4. **Flag team users read-only** on the shared instance. This prevents data changes during migration:
   ```sql
   UPDATE users SET "suspendedAt" = NOW(), "suspendedReason" = 'Migration in progress'
   WHERE id IN ('user1', 'user2', ...);
   ```
   > **Note:** The export script automatically strips `suspendedAt` and `suspendedReason` from exported user records, so users will not be suspended on the tenant after import.

5. **Verify target tenant** is accessible and has an empty database with the correct schema:
   ```bash
   DATABASE_URL=postgres://tenant-host:5432/pagespace pnpm db:migrate
   ```

### Rollback: Pre-migration
- Remove read-only flag: `UPDATE users SET "suspendedAt" = NULL, "suspendedReason" = NULL WHERE id IN (...);`
- Notify team that migration is cancelled/rescheduled

---

## Export

1. **Run the export** from the shared instance:
   ```bash
   tsx scripts/tenant-export.ts \
     --users user1,user2 \
     --output ./migration-bundle \
     --database-url postgres://shared-host:5432/pagespace \
     --file-storage-path /data/shared/files
   ```

2. **Verify the export bundle**:
   - Check `migration-bundle/manifest.json` for correct row counts
   - Check `migration-bundle/files/` for expected file blobs
   - Check `migration-bundle/data.sql` opens and contains INSERT statements

3. **Copy the bundle** to the target server (if not same host):
   ```bash
   rsync -avz ./migration-bundle/ target-host:/tmp/migration-bundle/
   ```

### Rollback: Export
- Delete the export bundle: `rm -rf ./migration-bundle`
- Remove read-only flag and notify team

---

## Import

1. **Run the import** on the target tenant database:
   ```bash
   tsx scripts/tenant-import.ts \
     --bundle ./migration-bundle \
     --database-url postgres://tenant-host:5432/pagespace \
     --file-storage-path /data/tenant/files
   ```

2. **Verify import summary** — check that:
   - `Rows imported` is greater than 0
   - `Rows skipped` is 0 (first import)
   - `Checksum mismatches` is 0
   - `Files imported` matches expected count

### Rollback: Import
- Truncate all tables in the target database:
  ```sql
  TRUNCATE TABLE favorites, user_mentions, mentions, page_permissions, permissions,
    file_pages, files, messages, conversations, channel_read_status,
    channel_message_reactions, channel_messages, chat_messages, page_tags, tags,
    pages, drive_members, drive_roles, drives, user_profiles, users CASCADE;
  ```
- Delete imported files: `rm -rf /data/tenant/files/*`
- Re-run import after fixing any issues

---

## Validate

1. **Run the validation tool** comparing source and target:
   ```bash
   tsx scripts/tenant-validate.ts \
     --source-url postgres://shared-host:5432/pagespace \
     --target-url postgres://tenant-host:5432/pagespace \
     --users user1,user2 \
     --source-file-path /data/shared/files \
     --target-file-path /data/tenant/files
   ```

2. **Expected output**: `Migration validated successfully`

3. **If validation fails**: check the detailed report for missing IDs or checksum mismatches. Fix the issue and re-run import (it's idempotent).

### Rollback: Validate
- If validation fails repeatedly, truncate target and re-export from source
- Consider if source data changed during export (should be impossible if users are read-only)

---

## DNS Switch

1. **Update DNS** to point the team's custom domain (or subdomain) to the tenant infrastructure:
   ```
   team.pagespace.ai → tenant-server-ip
   ```

2. **Update Caddy/reverse proxy** configuration on the tenant server to accept the domain.

3. **Wait for DNS propagation** (5-30 minutes depending on TTL).

4. **Verify the tenant** is accessible at the new URL and users can log in.

5. **Remove read-only flag** on the shared instance (users will now be hitting the tenant):
   ```sql
   UPDATE users SET "suspendedAt" = NULL, "suspendedReason" = NULL
   WHERE id IN ('user1', 'user2', ...);
   ```

### Rollback: DNS Switch
- Revert DNS to point back to the shared instance
- Remove read-only flag on shared instance
- Notify team

---

## Cleanup

After a **30-day grace period** following successful migration:

1. **Verify** the team is not accessing the shared instance (check access logs).

2. **Soft-delete team data** from the shared database:
   ```sql
   -- Mark drives as trashed
   UPDATE drives SET "isTrashed" = TRUE, "trashedAt" = NOW()
   WHERE id IN (SELECT DISTINCT "driveId" FROM drive_members WHERE "userId" IN ('user1', 'user2', ...));

   -- Remove drive memberships
   DELETE FROM drive_members WHERE "userId" IN ('user1', 'user2', ...);

   -- Suspend user accounts (keep for audit trail)
   UPDATE users SET "suspendedAt" = NOW(), "suspendedReason" = 'Migrated to tenant'
   WHERE id IN ('user1', 'user2', ...);
   ```

3. **After 90 days**, permanently delete the soft-deleted data:
   ```sql
   -- Delete trashed drives (cascades to pages, messages, files, etc.)
   DELETE FROM drives WHERE "isTrashed" = TRUE
   AND "trashedAt" < NOW() - INTERVAL '90 days';
   ```

4. **Clean up file blobs** for deleted drives from the shared file storage.

### Rollback: Cleanup
- Before permanent deletion, data can be restored by un-trashing drives and un-suspending users
- After permanent deletion, restore from database backups if needed

---

## Summary Checklist

- [ ] Team notified of maintenance window
- [ ] User IDs verified
- [ ] Dry-run export completed successfully
- [ ] Users set to read-only on shared instance
- [ ] Target tenant provisioned and schema applied
- [ ] Export completed and bundle verified
- [ ] Bundle transferred to target server (if remote)
- [ ] Import completed with 0 errors
- [ ] Validation passed
- [ ] DNS updated and propagated
- [ ] Team can access tenant at new URL
- [ ] Read-only flag removed
- [ ] 30-day grace period timer started
- [ ] Soft-delete completed after grace period
- [ ] Permanent cleanup completed after 90 days
