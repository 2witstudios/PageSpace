# Rollback Feature Debug Guide

This guide is for debugging rollback and undo features using Claude Chrome extension.

## Prerequisites

1. **Enable debug logging**:
   ```bash
   # Backend (terminal)
   LOG_LEVEL=debug pnpm dev

   # Frontend (apps/web/.env.local)
   NEXT_PUBLIC_CLIENT_LOG_LEVEL=debug
   ```

2. **Start Claude Code with Chrome**:
   ```bash
   claude --chrome
   ```

3. **Verify connection**:
   ```text
   /chrome
   ```

---

## Log Prefixes Reference

| Feature | Prefix | Location |
|---------|--------|----------|
| AI Undo Preview | `[AiUndo:Preview]` | Both |
| AI Undo Execute | `[AiUndo:Execute]` | Both |
| Rollback Preview | `[Rollback:Preview]` | Both |
| Rollback Execute | `[Rollback:Execute]` | Both |
| Rollback Permission | `[Rollback:Permission]` | Backend |
| History Fetch | `[History:Fetch]` | Frontend |
| History Panel | `[History:Panel]` | Frontend |
| History Route | `[History:Route]` | Backend |
| Rollback Dialog | `[Rollback:Dialog]` | Frontend |

---

## Files with Debug Logging

### Backend Services
- `apps/web/src/services/api/ai-undo-service.ts`
- `apps/web/src/services/api/rollback-service.ts`
- `packages/lib/src/permissions/rollback-permissions.ts`

### API Routes
- `apps/web/src/app/api/ai/chat/messages/[messageId]/undo/route.ts`
- `apps/web/src/app/api/activities/[activityId]/rollback/route.ts`
- `apps/web/src/app/api/pages/[pageId]/history/route.ts`
- `apps/web/src/app/api/drives/[driveId]/history/route.ts`

### Frontend Components
- `apps/web/src/components/ai/shared/chat/UndoAiChangesDialog.tsx`
- `apps/web/src/components/version-history/VersionHistoryPanel.tsx`
- `apps/web/src/components/version-history/VersionHistoryItem.tsx`
- `apps/web/src/components/version-history/RollbackConfirmDialog.tsx`

---

## Debug Scenarios

### Scenario 1: Version History Panel

**Navigation Path:**
1. `localhost:3000` -> Login
2. Open any drive -> Open any page
3. Click page menu (three dots) -> "Version History"

**Claude Chrome Commands:**
```text
Navigate to localhost:3000 and login if needed.

Then open a drive, open a page, and click on the page menu to open
Version History panel.

Check the browser console for logs starting with [History:Panel]
and [History:Fetch]. Report the full log sequence.
```

**Expected Console Logs:**
```text
[History:Panel] Panel opened, triggering fetch {pageId, driveId, showAiOnly, operationFilter}
[History:Fetch] Starting fetch {context, pageId, driveId, reset, offset, showAiOnly, operationFilter}
[History:Fetch] Fetch successful {versionsCount, total, hasMore, retentionDays}
```

**Expected Terminal Logs:**
```text
[History:Route] GET page history request {pageId, userId}
[History:Fetch] Page history query complete {pageId, activitiesCount, total}
[History:Route] Returning page history {versionsCount, total, retentionDays}
```

---

### Scenario 2: Version History Filters

**Navigation Path:**
1. Open Version History panel (from Scenario 1)
2. Toggle "AI only" switch
3. Change operation filter dropdown

**Claude Chrome Commands:**
```text
With the Version History panel open, toggle the "AI only" switch
and watch the console for new [History:Fetch] logs.

Then change the operation filter to "Updates" and check for
another fetch cycle in the logs.
```

**Expected Console Logs:**
```text
[History:Panel] Panel opened, triggering fetch {showAiOnly: true, operationFilter: 'all'}
[History:Fetch] Starting fetch {showAiOnly: true}
[History:Fetch] Fetch successful {versionsCount: N}
```

---

### Scenario 3: Rollback from Version History

**Navigation Path:**
1. Open Version History panel
2. Hover over an activity item
3. Click three-dot menu -> "Restore this version"
4. Confirm in dialog

**Claude Chrome Commands:**
```text
In the Version History panel, find an activity that has a restore
option (hover to see the menu). Click the three-dot menu and select
"Restore this version".

Check console for [Rollback:Preview] logs. Then click "Restore Version"
in the confirmation dialog and check for [Rollback:Execute] and
[Rollback:Dialog] logs.

Report the full sequence of logs from both console and terminal.
```

**Expected Console Logs:**
```text
[Rollback:Preview] User clicked restore version {activityId, operation, resourceType, context}
[Rollback:Preview] Preview loaded {activityId, warningsCount}
[Rollback:Dialog] User clicked confirm {resourceTitle, operation, warningsCount}
[Rollback:Execute] User confirmed rollback via dialog {activityId}
[Rollback:Execute] User initiated rollback from history panel {activityId, context}
[Rollback:Execute] Rollback completed successfully {activityId}
[Rollback:Dialog] Rollback confirmed and completed successfully
```

**Expected Terminal Logs:**
```text
[Rollback:Route] POST request received {activityId, userId}
[Rollback:Preview] Starting preview {activityId, userId, context}
[Rollback:Preview] Activity found {operation, resourceType, hasSnapshotData}
[Rollback:Permission] Checking rollback permission {userId, activityId, context}
[Rollback:Permission] Permission granted {canRollback: true}
[Rollback:Execute] Starting rollback execution {activityId}
[Rollback:Execute] Executing handler {resourceType}
[Rollback:Execute] Rollback complete {rollbackActivityId}
[Rollback:Route] Rollback succeeded {rollbackActivityId}
```

---

### Scenario 4: AI Chat Undo (Messages Only)

**Navigation Path:**
1. Open a page with Page AI chat
2. Send a message to AI (just a question, no tool use)
3. Click "Undo from here" on an AI message
4. Select "Revert conversation only"
5. Click "Undo"

**Claude Chrome Commands:**
```text
Navigate to a page that has AI chat enabled. Send a simple question
to the AI like "What is this page about?".

After the AI responds, click "Undo from here" on that message.
Select "Revert conversation only" and click Undo.

Check console for [AiUndo:Preview] and [AiUndo:Execute] logs and
report the full sequence.
```

**Expected Console Logs:**
```text
[AiUndo:Preview] Dialog opened, fetching preview {messageId}
[AiUndo:Preview] Preview loaded successfully {messageId, affectedMessages, rollbackableActivities}
[AiUndo:Execute] User confirmed undo {messageId, mode: 'messages_only'}
[AiUndo:Execute] Undo completed successfully {messageId}
```

**Expected Terminal Logs:**
```text
[AiUndo:Route] GET request received {messageId, userId}
[AiUndo:Preview] Starting preview {messageId, userId}
[AiUndo:Preview] Found message {role, createdAt}
[AiUndo:Preview] Checking activities for rollback eligibility {activitiesCount}
[AiUndo:Preview] Preview complete {messagesAffected, activitiesEligible}
[AiUndo:Route] POST request received {messageId, userId, mode: 'messages_only'}
[AiUndo:Execute] Starting execution {messageId, mode: 'messages_only'}
[AiUndo:Execute] Starting transaction
[AiUndo:Execute] Transaction committed successfully {messagesDeleted}
```

---

### Scenario 5: AI Chat Undo (Messages + Changes)

**Navigation Path:**
1. Open a page with Page AI chat
2. Ask AI to make a change (e.g., "Add a heading that says Hello")
3. Wait for AI to use tools and make changes
4. Click "Undo from here" on the AI message
5. Select "Revert conversation + all changes"
6. Click "Undo"

**Claude Chrome Commands:**
```text
Navigate to a page with AI chat. Ask the AI to make a visible change
like "Add a heading that says Test at the top of this page".

Wait for the AI to complete the tool calls. Then click "Undo from here"
on that AI message.

Select "Revert conversation + all changes" and click Undo.

Check console for [AiUndo:] logs and terminal for [AiUndo:] logs.
Report if the page content was reverted along with the messages.
```

**Expected Console Logs:**
```text
[AiUndo:Preview] Dialog opened, fetching preview {messageId}
[AiUndo:Preview] Preview loaded successfully {messageId, affectedMessages, rollbackableActivities: 1+}
[AiUndo:Execute] User confirmed undo {messageId, mode: 'messages_and_changes'}
[AiUndo:Execute] Undo completed successfully {messageId}
```

**Expected Terminal Logs:**
```text
[AiUndo:Preview] Checking activities for rollback eligibility {activitiesCount}
[AiUndo:Preview] Activity eligible for rollback {activityId, operation}
[AiUndo:Execute] Starting execution {messageId, mode: 'messages_and_changes'}
[AiUndo:Execute] Rolling back activity {activityId, operation}
[AiUndo:Execute] Activity rolled back successfully {activityId}
[AiUndo:Execute] Transaction committed successfully {messagesDeleted, activitiesRolledBack}
```

---

### Scenario 6: Global Assistant Undo

**Navigation Path:**
1. Open Global Assistant (not page-level AI)
2. Have a conversation with tool use
3. Click "Undo from here" on a message
4. Test both undo modes

**Claude Chrome Commands:**
```text
Open the Global Assistant chat (should be accessible from the sidebar
or header, not the page-level AI).

Ask it to do something like "Search for pages containing the word test".

After it responds, try clicking "Undo from here" on a message.
Check if the undo UI appears and test both modes.

Report any [AiUndo:] logs in console and [AiUndo:] logs in terminal.
```

---

### Scenario 7: Non-Rollbackable Activities

**Navigation Path:**
1. Open Version History panel
2. Look for activities without restore option (login, view, etc.)

**Claude Chrome Commands:**
```text
Open the Version History panel and look for activities that don't
have a "Restore this version" option when you hover over them.

These might be login events, page views, or other non-reversible actions.

Check the terminal logs for [Rollback:Permission] entries that show
why certain activities are not rollbackable.
```

**Expected Terminal Logs:**
```text
[Rollback:Permission] Checking rollback permission {userId, activityId, context}
[Rollback:Permission] No snapshot data available {activityId}
[Rollback:Permission] Permission denied {canRollback: false, reason: 'no_snapshot'}
```

---

### Scenario 8: Drive-Level History

**Navigation Path:**
1. Go to drive settings or drive activity page
2. Open Version History at drive level

**Claude Chrome Commands:**
```text
Navigate to a drive's settings or activity page where you can see
drive-level version history (not page-specific).

Open the Version History panel and check for [History:] logs that
show driveId instead of pageId.

Try a rollback from this context and verify the context is 'drive'.
```

**Expected Console Logs:**
```text
[History:Panel] Panel opened, triggering fetch {driveId: 'xxx', pageId: undefined}
[History:Fetch] Starting fetch {context: 'drive', driveId: 'xxx'}
```

---

## Debugging Failures

### If History Doesn't Load

Check for:
```text
[History:Fetch] Fetch failed with status {status, statusText}
[History:Fetch] Fetch error {error}
```

Common causes:
- User not authenticated
- Page/drive doesn't exist
- Permission denied

### If Rollback Fails

Check for:
```text
[Rollback:Preview] Preview fetch failed {activityId, status}
[Rollback:Execute] Rollback failed {activityId, error}
[Rollback:Dialog] Rollback failed {error}
```

Common causes:
- Activity no longer exists
- Snapshot data corrupted
- Permission changed since preview

### If Undo Fails

Check for:
```text
[AiUndo:Preview] Preview failed {messageId, error}
[AiUndo:Execute] Undo failed {messageId, error}
```

Common causes:
- Message already deleted
- Conversation not found
- Activity rollback failed (for messages_and_changes mode)

---

## Quick Console Filter Commands

In browser DevTools console, filter logs:

```javascript
// Show only rollback logs
// Use filter: [Rollback

// Show only history logs
// Use filter: [History

// Show only undo logs
// Use filter: [Undo

// Show all debug logs from our components
// Use filter: [AiUndo OR [Undo OR [Rollback OR [History
```

---

## Terminal Grep Commands

```bash
# Filter backend logs for rollback
pnpm dev 2>&1 | grep -E '\[(AiUndo|Rollback|History):'

# Filter for specific feature
pnpm dev 2>&1 | grep '\[Rollback:'
pnpm dev 2>&1 | grep '\[AiUndo:'
pnpm dev 2>&1 | grep '\[History:'
```
