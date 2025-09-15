# Social Features Simplification Plan

## Current State
The social features (connections, direct messages, profiles) have been implemented but the connections search functionality is broken and overly complex.

### Issues Identified
1. **Search API Error**: `/api/connections/search` fails with "Cannot read properties of undefined (reading 'user1Id')"
2. **Complexity**: Current system uses usernames, handles, discriminators - too complex
3. **User Experience**: Users expect simple email-based connections (like page permissions)

## Proposed Solution: Email-Based Connections

### Core Principle
Simplify connections to work exactly like page permissions - enter an email, find the user, send request.

## Implementation Plan

### Phase 1: Fix and Simplify API Routes

#### 1.1 Simplify `/api/connections/search` route
**File**: `/apps/web/src/app/api/connections/search/route.ts`

**Current Issues**:
- Complex logic to exclude existing connections is failing
- Trying to access `user1Id` on potentially undefined data
- Searching across multiple fields (username, handle, display name)

**Changes Needed**:
```typescript
// Remove complex exclusion logic
// Simply search by exact email match
// Return user if found, empty if not
```

#### 1.2 Alternative: Remove search endpoint entirely
- Use existing `/api/users/find?email={email}` endpoint (already used by page permissions)
- This endpoint already works and is battle-tested

### Phase 2: Simplify UI Components

#### 2.1 Update Connections Page
**File**: `/apps/web/src/app/dashboard/connections/page.tsx`

**Changes**:
1. Replace "Discover" tab with "Add Connection" tab
2. Change from search interface to simple email input
3. Add single "Connect" button after email input
4. Show clear success/error messages

**New UI Flow**:
```
[Email Input] → [Connect Button] → Success/Error Message
```

#### 2.2 Remove Complex Search UI
- Remove username/handle search
- Remove search results list
- Keep only email-based connection sending

### Phase 3: Clean Up Database Schema (Optional)

#### 3.1 Consider Removing Unused Tables
- `user_handles` table - not needed for email-based system
- Keep `connections`, `dm_conversations`, `direct_messages`

### Phase 4: Update User Profile

#### 4.1 Simplify Profile Page
**File**: `/apps/web/src/app/profile/page.tsx`

**Changes**:
- Remove user handle display
- Remove discriminator system
- Keep basic profile info (name, bio, avatar)
- Show email as primary identifier

## Implementation Steps

### Step 1: Fix Immediate Error
```typescript
// In /api/connections/search/route.ts
// Add null checks and error handling
if (!existingConnections || existingConnections.length === 0) {
  // Handle empty case
}
```

### Step 2: Simplify Search to Email Only
```typescript
// New simplified search
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');

  if (!email) {
    return NextResponse.json({ user: null });
  }

  // Find user by exact email match
  const user = await db.select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return NextResponse.json({ user: user[0] || null });
}
```

### Step 3: Update UI to Email-Only
```tsx
// Simplified connection component
<div>
  <Input
    type="email"
    placeholder="Enter email address"
    value={email}
    onChange={(e) => setEmail(e.target.value)}
  />
  <Button onClick={handleConnect}>
    Send Connection Request
  </Button>
</div>
```

### Step 4: Reuse Existing Patterns
- Copy the pattern from ShareDialog.tsx
- Use `/api/users/find` endpoint
- Show similar success/error messages

## Benefits of This Approach

1. **Simplicity**: Everyone understands email-based sharing
2. **Consistency**: Matches existing page permissions pattern
3. **Reliability**: Reuses tested code patterns
4. **User-Friendly**: No need to remember usernames or handles
5. **Less Code**: Removes complex search and filtering logic

## Migration Path

1. Fix current error with minimal changes
2. Add email-based connection option alongside existing search
3. Monitor usage and remove complex search if unused
4. Eventually deprecate username/handle system

## Testing Plan

1. Test email-based connection sending
2. Verify connection requests appear in pending tab
3. Test accepting/rejecting connections
4. Ensure direct messages work with connections
5. Test edge cases (self-connection, duplicate requests)

## Files to Modify

### Critical Files (Must Change):
- `/apps/web/src/app/api/connections/search/route.ts` - Fix or replace
- `/apps/web/src/app/dashboard/connections/page.tsx` - Simplify UI

### Optional Cleanup:
- `/apps/web/src/app/api/users/handle/route.ts` - Can be removed
- `/apps/web/src/app/profile/page.tsx` - Remove handle display
- `/packages/db/src/schema/social.ts` - Remove user_handles table

## Alternative Approach

If you want to keep some discovery features:
1. Keep email as primary connection method
2. Add optional "public profile" flag for users
3. Show only users with public profiles in discovery
4. Always require email for direct connection requests

## Next Steps

1. Review this plan
2. Decide on approach (fix current vs. simplify)
3. Implement changes incrementally
4. Test thoroughly
5. Deploy with monitoring

## Notes for Implementation

- The existing `/api/users/find` endpoint already handles email search perfectly
- The ShareDialog component has the exact pattern needed for email-based connections
- Consider keeping the UI structure but simplifying the search mechanism
- Database schema changes are optional - existing structure supports email-based flow

## Code References

### Working Email Search (from ShareDialog):
```typescript
const userResponse = await fetch(`/api/users/find?email=${encodeURIComponent(email)}`);
```

### Pattern to Copy:
- See `/apps/web/src/components/layout/middle-content/content-header/page-settings/ShareDialog.tsx`
- Lines 83-130 show the complete email-based sharing flow

This approach will make the social features more intuitive and maintainable while fixing the current issues.