# PageSpace Activity Logging Audit Report

**Date:** December 22, 2025
**Scope:** Drive management, rollback capability, and enterprise visibility
**Status:** Gap Analysis Complete

---

## Executive Summary

This audit categorizes activity logging needs into two distinct tiers:

### Tier 1: Drive Management & Rollback (User-Facing Priority)
Like Google Drive's activity monitor - focused on changes users might need to undo, AI-generated changes, and shared content integrity. **This is the immediate priority.**

### Tier 2: Enterprise Visibility (Future Compliance)
Authentication, billing, access patterns, and security audit trails. Important for enterprise customers but not related to content rollback. **Architect for this now, implement later.**

---

## TIER 1: Drive Management & Rollback

These are gaps that affect users' ability to see what changed in their workspace and potentially roll back accidental or AI-generated changes.

### 1.1 Message Editing in Shared Contexts (HIGH - Affects Data Integrity)

When users can edit message history in shared chats, other participants need visibility into what changed.

| Operation | Route | Status | Why It Matters |
|-----------|-------|--------|----------------|
| Edit AI Chat Message | `/api/ai/chat/messages/[messageId]` PATCH | **NO LOGGING** | Shared AI chats - history can be rewritten |
| Delete AI Chat Message | `/api/ai/chat/messages/[messageId]` DELETE | **NO LOGGING** | Content disappears from shared context |
| Edit Global AI Message | `/api/ai/global/[id]/messages/[messageId]` PATCH | **NO LOGGING** | History modification |
| Delete Global AI Message | `/api/ai/global/[id]/messages/[messageId]` DELETE | **NO LOGGING** | Content removal |

**Note:** Message *creation* doesn't need rollback logging - you can't "undo" sending a message. But *editing* and *deleting* existing messages in shared contexts does.

### 1.2 AI Agent Making Changes (HIGH - Rollback Critical)

When AI tools modify content, users need to see what the AI did and potentially undo it.

| Gap | Location | Status | Why It Matters |
|-----|----------|--------|----------------|
| ask_agent chain tracking | `agent-communication-tools.ts` | **PARTIAL** | When sub-agent makes changes, parent context lost |
| Agent config via API | `/api/ai/page-agents/[agentId]/config` | **NO LOGGING** | System prompt changes affect AI behavior |
| Page agent config | `/api/pages/[pageId]/agent-config` | **NO LOGGING** | Visibility/tool changes |

**Already Working Well:**
- ✅ `create_page`, `replace_lines`, `rename_page` - logged with `isAiGenerated=true`
- ✅ `trash`, `restore`, `move_page` - logged with AI attribution
- ✅ `edit_sheet_cells` - logged with AI metadata
- ✅ `create_drive`, `rename_drive` - logged with AI metadata

**Gap:** When `ask_agent` calls another agent and that agent uses tools, we log the tool use but lose the chain context (which agent initiated it, why).

### 1.3 Role & Permission Changes (MEDIUM - Access Control State)

Changes to who can do what in a drive.

| Operation | Route | Status | Why It Matters |
|-----------|-------|--------|----------------|
| Reorder Roles | `/api/drives/[driveId]/roles/reorder` | **NO LOGGING** | Role hierarchy affects permissions |

**Already Working:**
- ✅ Role create/update/delete
- ✅ Member add/remove/role change
- ✅ Permission grant/update/revoke

### 1.4 Drive Ownership Transfer (MEDIUM - Major State Change)

| Operation | Route | Status | Why It Matters |
|-----------|-------|--------|----------------|
| Transfer Ownership | `/api/account/handle-drive` | **NO LOGGING** | Fundamental ownership change |

### 1.5 Channel Messages (LOW - Consider for Completeness)

| Operation | Route | Status | Why It Matters |
|-----------|-------|--------|----------------|
| Post Channel Message | `/api/channels/[pageId]/messages` POST | **NO LOGGING** | Creates content in shared space |

**Note:** This is lower priority since channel messages are typically append-only. If editing/deleting channel messages becomes possible, that would need logging.

---

## TIER 1 IMPLEMENTATION PRIORITY

### Sprint 1 (Immediate - User Impact)
1. **Message editing/deletion logging** - Add to AI chat and global assistant routes
2. **Agent config API logging** - Match what the AI tool version already does
3. **Role reorder logging** - Simple addition

### Sprint 2 (AI Chain Tracking)
1. **ask_agent chain context** - Add `parentAgentId` and `initiatingConversationId` to activity logs when sub-agents make changes
2. **Drive ownership transfer logging**

### Schema Changes for Tier 1

```sql
-- Minimal additions needed:
-- Add to activityOperationEnum:
'message_update'
'message_delete'
'role_reorder'
'ownership_transfer'

-- Add to activityResourceEnum:
'message'
```

New logging function:
```typescript
logMessageActivity(userId, operation, message, pageId, actorInfo)
```

---

## TIER 2: Enterprise Visibility (Architect Now, Implement Later)

These operations matter for compliance, security audits, and enterprise customers but are NOT about content rollback.

### 2.1 Authentication Events

| Operation | Route | Current State |
|-----------|-------|---------------|
| Login | `/api/auth/login` | Uses `trackAuthEvent()` - separate system |
| Signup | `/api/auth/signup` | Uses `trackAuthEvent()` - separate system |
| Logout | `/api/auth/logout` | Uses `trackAuthEvent()` - separate system |
| OAuth | `/api/auth/google/callback` | Uses `trackAuthEvent()` - separate system |

**Architecture Note:** Currently using a parallel tracking system (`trackAuthEvent`). For enterprise, unify into `activityLogs` table, but this doesn't affect users' drive activity view.

### 2.2 Billing & Subscription (SOX Compliance)

| Operation | Route | Current State |
|-----------|-------|---------------|
| Create/Update/Cancel Subscription | `/api/stripe/*` | No logging |
| Payment Methods | `/api/stripe/payment-methods` | No logging |
| Billing Address | `/api/stripe/billing-address` | No logging |

**Architecture Note:** These are financial audit requirements. Users won't "rollback" a subscription change through the activity monitor.

### 2.3 API Key & Token Management (Security Audit)

| Operation | Route | Current State |
|-----------|-------|---------------|
| AI API Keys | `/api/ai/settings` | No logging |
| MCP Token List | `/api/auth/mcp-tokens` GET | No logging (enumeration) |
| Batch Device Revocation | `/api/account/devices` DELETE | No logging |

### 2.4 User Settings & Preferences

| Operation | Route | Current State |
|-----------|-------|---------------|
| Notification Preferences | `/api/settings/notification-preferences` | No logging |
| Avatar Changes | `/api/account/avatar` | No logging |

### 2.5 Social/Connection Features

| Operation | Route | Current State |
|-----------|-------|---------------|
| Connection Requests | `/api/connections/*` | No logging |

### 2.6 Access Logging (Read Operations)

| Operation | Route | Current State |
|-----------|-------|---------------|
| File View | `/api/files/[id]/view` | No logging |
| File Download | `/api/files/[id]/download` | No logging |
| MCP Document Read | `/api/mcp/documents` (read) | No logging |

**Architecture Note:** Read logging is high-volume. Consider sampling or separate access_logs table for enterprise tier.

---

## TIER 2 SCHEMA PREPARATION

For future enterprise implementation, the schema should eventually support:

```sql
-- Future additions to activityOperationEnum:
'login', 'logout', 'signup'  -- Already exist but not used consistently
'subscription_create', 'subscription_update', 'subscription_cancel'
'settings_update'
'connection_request', 'connection_accept', 'connection_block'
'access'  -- For read logging

-- Future additions to activityResourceEnum:
'subscription', 'payment', 'settings', 'connection'
```

---

## Current Infrastructure (Reference)

### Activity Log Schema
**Table:** `activityLogs` in `packages/db/src/schema/monitoring.ts`

**Supported Operations (24):**
- Content: `create`, `update`, `delete`, `restore`, `reorder`, `move`, `trash`
- Permissions: `permission_grant`, `permission_update`, `permission_revoke`
- Membership: `member_add`, `member_remove`, `member_role_change`
- Auth: `login`, `logout`, `signup`, `password_change`, `email_change`
- Tokens: `token_create`, `token_revoke`
- Files: `upload`, `convert`
- Account: `account_delete`, `profile_update`, `avatar_update`
- Agents: `agent_config_update`

**Resource Types (10):**
`page`, `drive`, `permission`, `agent`, `user`, `member`, `role`, `file`, `token`, `device`

**Logging Functions:** `packages/lib/src/monitoring/activity-logger.ts`
- `logPageActivity()`, `logDriveActivity()`, `logPermissionActivity()`
- `logMemberActivity()`, `logRoleActivity()`, `logUserActivity()`
- `logTokenActivity()`, `logFileActivity()`, `logAgentConfigActivity()`

---

## Operations Already Logged (Reference)

### Page Operations
- Create page
- Update page (with `updatedFields`, `previousValues`, `newValues`)
- Trash page
- Permanent delete page
- Restore page
- Reorder pages
- Move page
- Export page (CSV, DOCX, XLSX)

### Drive Operations
- Create drive
- Update drive
- Trash drive
- Restore drive

### Permission Operations
- Grant permission
- Update permission
- Revoke permission

### Membership Operations
- Add member (including via invite)
- Remove member
- Change member role

### Role Operations
- Create role
- Update role
- Delete role

### Token Operations
- Create MCP token
- Revoke MCP token
- Revoke device token (individual)

### User Account Operations
- Profile update
- Password change
- Account delete

### File Operations
- Upload
- Convert to document

### AI Tool Operations (with AI metadata)
- create_page, replace_lines, rename_page
- trash, restore, move_page
- edit_sheet_cells, create_drive, rename_drive
- update_agent_config (tool version)
- update_task (logs linked page creation)

---

## Appendix: Files Requiring Changes

### Tier 1 (Drive Management / Rollback) - Implement Now
- `apps/web/src/app/api/ai/chat/messages/[messageId]/route.ts` (edit/delete)
- `apps/web/src/app/api/ai/global/[id]/messages/[messageId]/route.ts` (edit/delete)
- `apps/web/src/app/api/ai/page-agents/[agentId]/config/route.ts`
- `apps/web/src/app/api/pages/[pageId]/agent-config/route.ts`
- `apps/web/src/app/api/drives/[driveId]/roles/reorder/route.ts`
- `apps/web/src/app/api/account/handle-drive/route.ts` (ownership transfer)
- `apps/web/src/lib/ai/tools/agent-communication-tools.ts` (ask_agent chain tracking)

### Tier 2 (Enterprise Visibility) - Architect Now, Implement Later
- `apps/web/src/app/api/auth/login/route.ts`
- `apps/web/src/app/api/auth/signup/route.ts`
- `apps/web/src/app/api/auth/logout/route.ts`
- `apps/web/src/app/api/stripe/*.ts` (all billing routes)
- `apps/web/src/app/api/ai/settings/route.ts` (API key management)
- `apps/web/src/app/api/auth/mcp-tokens/route.ts` (GET - enumeration)
- `apps/web/src/app/api/settings/notification-preferences/route.ts`
- `apps/web/src/app/api/account/avatar/route.ts`
- `apps/web/src/app/api/connections/*.ts`
- `apps/web/src/app/api/files/[id]/view/route.ts` (access logging)
- `apps/web/src/app/api/files/[id]/download/route.ts` (access logging)

### Schema Changes
- `packages/db/src/schema/monitoring.ts` (add new operations and resource types)
- `packages/lib/src/monitoring/activity-logger.ts` (add new logging functions)
