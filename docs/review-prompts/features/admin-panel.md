# Review Vector: Admin Panel

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- permissions.mdc
- security.mdc

## Scope
**Files**: `apps/web/src/components/admin/**`, `apps/web/src/app/api/admin/**`
**Level**: domain

## Context
The admin panel provides system-level user management, audit logs, and platform configuration, restricted to users with the admin role. Every admin API route must verify admin authorization independently rather than relying on frontend route guards alone. Audit log queries must support filtering and pagination over potentially large datasets while maintaining query performance through proper indexing and cursor-based pagination.
