# Review Vector: Invite Team Member

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/drives/[driveId]/members/invite/route.ts`, `apps/web/src/app/api/drives/[driveId]/members/route.ts`, `apps/web/src/app/api/drives/[driveId]/members/[userId]/route.ts`, `apps/web/src/app/api/account/handle-drive/route.ts`, `packages/lib/src/services/drive-member-service.ts`, `packages/lib/src/services/email-service.ts`, `packages/lib/src/email-templates/DriveInvitationEmail.tsx`, `packages/lib/src/email-templates/DriveJoinedEmail.tsx`, `packages/db/src/schema/members.ts`, `packages/lib/src/permissions/permissions.ts`
**Level**: domain

## Context
The invitation journey starts when a drive admin sends an invite via the members invite API, which validates the caller's permission level, creates a pending invitation record, and dispatches an invitation email through the email service. The recipient clicks the link, which routes to the handle-drive account API to accept or decline. Accepting inserts the new member record via the drive member service with the assigned role. This flow spans the invitation API with permission checks, email template rendering and delivery, invitation acceptance handling, database member records, and permission initialization for the new member.
