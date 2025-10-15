# Database-First AI Architecture Testing Guide

## Overview

This guide provides comprehensive testing procedures to verify that the database-first AI architecture works correctly, particularly focusing on message edit visibility and multi-user scenarios.

## Prerequisites

- PageSpace development environment running
- Access to database (for direct edits)
- Two browser instances or incognito windows (for multi-user testing)
- Access to browser DevTools console

## Test Suite

### Test 1: Basic Message Edit Visibility

**Objective:** Verify that editing a message makes it immediately visible to the AI in the next response.

**Steps:**

1. **Create a conversation:**
   - Open Global Assistant or Page AI
   - Send a message: "My favorite color is blue"
   - Wait for AI response

2. **Edit the message:**
   - Click the edit button on your message
   - Change it to: "My favorite color is red"
   - Save the edit
   - Verify "Message updated successfully" appears

3. **Test AI sees the edit:**
   - Send a follow-up message: "What is my favorite color?"
   - **Expected:** AI responds "red" (not "blue")
   - **Actual:** _____

**Result:** ✅ Pass / ❌ Fail

**Notes:**
- If AI responds with "blue", the database-first pattern is not working
- Check server logs for "Loading conversation history from database"
- Verify database shows updated content

---

### Test 2: Retry with Edited Message

**Objective:** Verify that retrying after editing uses the edited content.

**Steps:**

1. **Create a conversation:**
   - Send message: "Tell me about cats"
   - Wait for AI response

2. **Edit your message:**
   - Edit to: "Tell me about dogs"
   - Save the edit

3. **Retry the conversation:**
   - Click retry button on the last AI response
   - **Expected:** AI generates new response about dogs
   - **Actual:** _____

**Result:** ✅ Pass / ❌ Fail

**Notes:**
- Verify only one assistant response exists after retry
- Check that database doesn't have multiple assistant responses

---

### Test 3: Multi-User Edit Visibility

**Objective:** Verify that edits by User A are visible to User B's AI context.

**Prerequisites:**
- Two user accounts
- Shared conversation (for Global AI) or shared page access (for Page AI)

**Steps:**

1. **User A creates conversation:**
   - Open conversation in Browser 1
   - Send: "The project deadline is June 1st"
   - Wait for AI response

2. **User B joins conversation:**
   - Open same conversation in Browser 2
   - Verify message is visible

3. **User A edits message:**
   - In Browser 1, edit message to: "The project deadline is July 15th"
   - Save edit

4. **User B sends follow-up:**
   - In Browser 2, send: "When is the deadline?"
   - **Expected:** AI responds "July 15th" (not "June 1st")
   - **Actual:** _____

**Result:** ✅ Pass / ❌ Fail

**Notes:**
- This tests that database is the source of truth for all users
- Verify User B's request uses database-loaded messages

---

### Test 4: Complex Edit Scenario

**Objective:** Verify edits work correctly in longer conversations with multiple edits.

**Steps:**

1. **Create conversation with 5+ messages:**
   - Message 1: "I live in New York"
   - AI responds
   - Message 2: "I work in finance"
   - AI responds
   - Message 3: "I love pizza"
   - AI responds

2. **Edit message in the middle:**
   - Edit Message 1 to: "I live in Tokyo"
   - Edit Message 2 to: "I work in technology"
   - Save both edits

3. **Test AI context:**
   - Send: "Tell me about my life based on what I've shared"
   - **Expected:** AI mentions Tokyo and technology
   - **Actual:** _____

**Result:** ✅ Pass / ❌ Fail

**Notes:**
- Tests that all messages are loaded from database, not just recent ones
- Verify conversation history is complete

---

### Test 5: Database Direct Edit

**Objective:** Verify that direct database edits are reflected in AI context.

**Steps:**

1. **Create a conversation:**
   - Send: "The password is ABC123"
   - Wait for AI response

2. **Edit directly in database:**
   ```sql
   UPDATE messages
   SET content = 'The password is XYZ789',
       editedAt = NOW()
   WHERE content LIKE '%ABC123%';
   ```
   (Adjust table name for Global AI vs Page AI)

3. **Send follow-up in UI:**
   - Send: "What is the password?"
   - **Expected:** AI responds "XYZ789"
   - **Actual:** _____

**Result:** ✅ Pass / ❌ Fail

**Notes:**
- This is the ultimate test of database-first architecture
- If this fails, API is using client messages instead of database

---

### Test 6: Message with Tool Calls

**Objective:** Verify edited messages with tool calls are properly loaded.

**Steps:**

1. **Trigger tool usage:**
   - Send message that requires a tool: "List all pages in this drive"
   - Wait for AI to execute tool and respond

2. **Edit the message:**
   - Edit to: "List all folders in this drive"
   - Save edit

3. **Send follow-up:**
   - Send: "What did I just ask you to list?"
   - **Expected:** AI says "folders" (not "pages")
   - **Actual:** _____

**Result:** ✅ Pass / ❌ Fail

**Notes:**
- Tests that tool call reconstruction works with edited messages
- Verify `convertDbMessageToUIMessage` properly handles tool parts

---

### Test 7: Large Conversation Performance

**Objective:** Verify database loading performs well with large conversations.

**Steps:**

1. **Create conversation with 100+ messages:**
   - Use a script or manually create a long conversation

2. **Measure response time:**
   - Open browser DevTools → Network tab
   - Send a new message
   - Measure time from request to first response chunk
   - **Expected:** < 2 seconds for first chunk
   - **Actual:** _____

3. **Check database query performance:**
   - Review server logs for query time
   - **Expected:** Database query < 100ms
   - **Actual:** _____

**Result:** ✅ Pass / ❌ Fail

**Notes:**
- If slow, consider adding database indexes
- Check if `orderBy(messages.createdAt)` has appropriate index

---

### Test 8: Concurrent Edits

**Objective:** Verify no data corruption with concurrent edits.

**Steps:**

1. **Setup:**
   - Open same conversation in two browser windows
   - Both windows show the same message

2. **Concurrent edit:**
   - Browser 1: Edit message to "Version A"
   - Browser 2: Edit same message to "Version B"
   - Save both simultaneously

3. **Verify consistency:**
   - Refresh both browsers
   - Check database content
   - **Expected:** One version wins (last write), no corruption
   - **Actual:** _____

4. **Test AI sees latest:**
   - Send follow-up message
   - **Expected:** AI uses the version in database
   - **Actual:** _____

**Result:** ✅ Pass / ❌ Fail

**Notes:**
- This tests database transaction handling
- Verify no partial updates or corruption

---

## Debugging Tips

### Verify Database-First Pattern

**Check server logs:**
```
# Should see these log messages:
📚 Global Assistant Chat API: Loading conversation history from database
✅ Global Assistant Chat API: Loaded conversation history from database
```

**Database query verification:**
```sql
-- Check that messages are being updated
SELECT id, content, editedAt, isActive
FROM messages
WHERE conversationId = 'YOUR_CONVERSATION_ID'
ORDER BY createdAt;
```

### Common Issues

**Issue 1: AI still sees old content after edit**

**Diagnosis:**
- Check server logs for "Loading conversation history from database"
- If missing, API is using client messages
- Verify lines 327-366 in Global AI or 369-404 in Page AI

**Fix:**
- Ensure `conversationHistory` is loaded from database
- Verify `sanitizeMessagesForModel(conversationHistory)` not `sanitizeMessagesForModel(requestMessages)`

---

**Issue 2: Messages not loading**

**Diagnosis:**
- Check database query returns results
- Verify `isActive = true` filter
- Check message conversion functions

**Fix:**
- Verify database has messages for the conversation
- Check that soft delete hasn't marked messages inactive
- Test conversion functions in isolation

---

**Issue 3: Performance degradation**

**Diagnosis:**
- Check database query execution time
- Verify indexes exist
- Check conversation size

**Fix:**
```sql
-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_messages_conversation_active
ON messages(conversationId, isActive, createdAt);

CREATE INDEX IF NOT EXISTS idx_chat_messages_page_active
ON chat_messages(pageId, isActive, createdAt);
```

---

## Manual Testing Script

Here's a bash script to automate some tests:

```bash
#!/bin/bash

# Database-First AI Testing Script

CONVERSATION_ID="your-conversation-id-here"
API_TOKEN="your-jwt-token-here"
API_BASE="http://localhost:3000"

echo "🧪 Testing Database-First AI Architecture"
echo "=========================================="

# Test 1: Send initial message
echo "📝 Test 1: Sending initial message..."
curl -X POST "$API_BASE/api/ai_conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "My favorite color is blue"}],
    "selectedProvider": "pagespace",
    "selectedModel": "glm-4.5-air"
  }'

sleep 2

# Test 2: Edit message in database
echo ""
echo "✏️  Test 2: Editing message in database..."
psql $DATABASE_URL -c \
  "UPDATE messages SET content = 'My favorite color is red', editedAt = NOW() WHERE content LIKE '%blue%';"

sleep 1

# Test 3: Send follow-up message
echo ""
echo "🤖 Test 3: Sending follow-up to test edit visibility..."
curl -X POST "$API_BASE/api/ai_conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "What is my favorite color?"}],
    "selectedProvider": "pagespace",
    "selectedModel": "glm-4.5-air"
  }'

echo ""
echo "✅ Tests complete! Check AI response mentions 'red' not 'blue'"
```

---

## Automated Test Cases (for CI/CD)

If implementing automated tests, here's a template:

```typescript
// __tests__/api/ai/database-first.test.ts

describe('Database-First AI Architecture', () => {
  it('should load messages from database, not client', async () => {
    // 1. Create conversation with a message
    const conversationId = await createTestConversation();
    await sendMessage(conversationId, 'Initial message');

    // 2. Edit message directly in database
    await db.update(messages)
      .set({ content: 'Edited message', editedAt: new Date() })
      .where(eq(messages.conversationId, conversationId));

    // 3. Send follow-up with OLD content in client request
    const response = await fetch('/api/ai_conversations/' + conversationId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'Initial message' }, // OLD content
          { role: 'user', content: 'What did I say?' }
        ]
      })
    });

    // 4. Verify AI used database content, not client content
    const aiResponse = await response.text();
    expect(aiResponse).toContain('Edited message');
    expect(aiResponse).not.toContain('Initial message');
  });

  it('should handle concurrent edits correctly', async () => {
    // Test concurrent edit scenario
    // ...
  });

  it('should maintain message order after edits', async () => {
    // Test that chronological order is preserved
    // ...
  });
});
```

---

## Test Results Template

Use this template to document your test results:

```
# Database-First AI Testing Results

Date: __________
Tester: __________
Environment: Development / Staging / Production

## Test Results Summary

| Test | Result | Notes |
|------|--------|-------|
| Basic Message Edit Visibility | ✅ / ❌ | |
| Retry with Edited Message | ✅ / ❌ | |
| Multi-User Edit Visibility | ✅ / ❌ | |
| Complex Edit Scenario | ✅ / ❌ | |
| Database Direct Edit | ✅ / ❌ | |
| Message with Tool Calls | ✅ / ❌ | |
| Large Conversation Performance | ✅ / ❌ | |
| Concurrent Edits | ✅ / ❌ | |

## Overall Assessment

✅ All tests passed - Database-first architecture working correctly
⚠️  Some tests failed - See notes for details
❌ Critical failures - Immediate attention required

## Issues Found

1.
2.
3.

## Recommendations

1.
2.
3.
```

---

## Conclusion

These tests verify that:
1. ✅ Database is the source of truth for all messages
2. ✅ Message edits are immediately visible to AI
3. ✅ Multi-user scenarios work correctly
4. ✅ Tool calls are properly reconstructed from database
5. ✅ Performance is acceptable with large conversations
6. ✅ No data corruption with concurrent operations

If all tests pass, the database-first AI architecture is working correctly!
