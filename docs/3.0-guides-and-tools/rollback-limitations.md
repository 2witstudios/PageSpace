# Rollback System: Known Limitations

This document describes operations that are intentionally **not rollbackable** or have **limited rollback support** in PageSpace.

## Non-Rollbackable Operations

### File Operations
**Upload, Delete, Convert** - Files are stored in content-addressed storage and are not version-controlled at the storage layer.

- **File upload**: Creates activity log but cannot be undone via rollback
- **File delete**: The file is permanently removed from storage
- **File convert**: Converted versions are not tracked separately

**Rationale**: File storage uses content-addressed deduplication. Implementing rollback would require versioning all file content, significantly increasing storage costs.

---

### Invitation Lifecycle
**Invitation acceptance/rejection** - These transitions are not logged as rollbackable activities.

- When a user accepts an invitation, only `member_add` is logged
- When a user rejects an invitation, no activity is logged
- Invitation expiration happens silently

**Rationale**: Invitations are transient. Once accepted, the member relationship exists; once rejected, the invitation no longer matters. Rolling back an acceptance is equivalent to removing the member.

---

### User Account Operations
**Login, logout, password changes, account deletion** - Security-sensitive operations cannot be rolled back.

- Password changes require user authentication, not admin rollback
- Account deletions are permanent for privacy compliance
- Session tokens cannot be "un-expired"

**Rationale**: These operations have security and compliance implications that prevent simple rollback.

---

## Limited Rollback Support

### AI Tool Side Effects
**Message restore vs. tool effects** - Restoring an AI message does **not** undo what the AI created.

When you undo an AI conversation:
- Messages are soft-deleted from the conversation
- **BUT** pages, tasks, or other resources created by AI tools remain

**Example**: If AI created "Project Plan" page via tool call, undoing the message leaves the page in place.

**Workaround**: Use the Version History panel on individual pages to rollback AI-generated content changes.

---

### Conversation Undo Resource Type
**`conversation` activities are logged but have no rollback handler** - The `logConversationUndo()` function creates activity entries, but the rollback service does not handle the `conversation` resource type.

If you attempt to rollback a conversation undo operation, you'll receive: "Rollback not supported for resource type: conversation"

**Workaround**: Use the AI Undo feature (`/api/ai/chat/messages/[messageId]/undo`) which handles message deletion and activity rollback as an atomic operation.

---

### Cross-Page Message Spanning
**Conversations with mixed page/global messages** - Some conversations have messages in both `chatMessages` (page-specific) and `messages` (global) tables.

When undoing such conversations:
- Only messages from the identified source table are affected
- Messages in the other table may remain orphaned

**Workaround**: Clear the conversation from both the page chat and global assistant if issues arise.

---

## Conflict Detection

### Modified Resources
When a resource has been modified since the activity you're trying to rollback:
- The rollback is **blocked by default** with `hasConflict: true`
- You must use `force: true` to proceed (overwrites newer changes)

**Example**: You updated a page at 2:00 PM, someone else edited at 3:00 PM. Rolling back to 2:00 PM state will lose the 3:00 PM edits unless you force it.

---

## Best Practices

1. **Use Version History for content rollback** - The Version History panel provides the most reliable rollback for page content.

2. **AI Undo for conversation cleanup** - Use the built-in AI undo feature rather than manual activity rollback.

3. **Check for conflicts** - The UI shows conflict warnings before rollback. Review what will be overwritten.

4. **Member removal is logged** - When removing a drive member, their page permissions are logged for audit purposes (but auto-restoration is not yet implemented).
