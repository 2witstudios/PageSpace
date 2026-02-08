# Review Vector: Admin Manage Users

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/admin/users/route.ts`, `apps/web/src/app/api/admin/users/[userId]/subscription/route.ts`, `apps/web/src/app/api/admin/users/[userId]/gift-subscription/route.ts`, `apps/web/src/app/api/admin/audit-logs/route.ts`, `apps/web/src/app/api/admin/audit-logs/export/route.ts`, `apps/web/src/app/api/admin/audit-logs/integrity/route.ts`, `apps/web/src/components/admin/UsersTable.tsx`, `apps/web/src/lib/auth/admin-role.ts`, `packages/db/src/schema/subscriptions.ts`, `packages/db/src/schema/security-audit.ts`
**Level**: domain

## Context
The admin user management journey begins in the admin panel where the UsersTable component fetches the user list from the admin users API, which enforces admin role verification. The admin can gift a subscription to a user via the gift-subscription endpoint, which creates or updates the subscription record in the database. All admin actions are recorded in the security audit log, viewable and exportable through the audit logs API with integrity verification. This flow crosses admin role authorization, user listing and management APIs, subscription database operations, the audit logging system with tamper-detection integrity checks, and the admin UI components.
