# Audit Trail & Versioning UI Components

Complete UI implementation for PageSpace's audit trail and versioning system.

## Components Overview

### 1. ActivityFeed
Displays chronological list of audit events for a drive with advanced filtering.

**Features:**
- Real-time updates via SWR (30s refresh interval)
- Filter by action type, date range, AI vs human actions
- Infinite scroll/pagination
- User avatars and action badges
- Links to affected entities

**Usage:**
```tsx
import { ActivityFeed } from '@/components/audit';

// In a drive view or settings page
<ActivityFeed
  driveId={driveId}
  showFilters={true}
  maxHeight="600px"
  limit={50}
/>
```

**Props:**
- `driveId: string` - Required. The drive ID to show activity for
- `showFilters?: boolean` - Optional. Show/hide filter controls (default: true)
- `maxHeight?: string` - Optional. Max height for scrollable area (default: "600px")
- `limit?: number` - Optional. Number of events per page (default: 50)

**API Endpoint:** `GET /api/drives/{driveId}/activity`

---

### 2. PageHistory
Version history viewer with restore functionality.

**Features:**
- List all versions of a page
- Show version metadata (number, timestamp, author, AI attribution)
- Restore to previous version with confirmation
- Change type badges (MAJOR, MINOR, PATCH)
- AI-generated version indicators

**Usage:**
```tsx
import { PageHistory } from '@/components/audit';

// In a page context menu or toolbar
<PageHistory
  pageId={pageId}
  onVersionRestored={() => {
    // Refresh page content
    mutate();
  }}
/>

// With custom trigger
<PageHistory
  pageId={pageId}
  trigger={
    <Button variant="ghost" size="sm">
      <History className="h-4 w-4 mr-2" />
      View History
    </Button>
  }
  onVersionRestored={handleRestore}
/>
```

**Props:**
- `pageId: string` - Required. The page ID to show history for
- `trigger?: React.ReactNode` - Optional. Custom trigger button (default: standard button)
- `onVersionRestored?: () => void` - Optional. Callback after successful restore

**API Endpoints:**
- `GET /api/pages/{pageId}/versions` - Get version list
- `POST /api/pages/{pageId}/versions` - Restore a version

---

### 3. VersionCompare
Side-by-side version comparison with diff highlighting.

**Features:**
- Compare any version with current version
- Syntax-highlighted diff view
- Line-by-line comparison
- Restore directly from comparison view
- Legend for added/removed/modified lines

**Usage:**
```tsx
import { VersionCompare } from '@/components/audit';

const [compareOpen, setCompareOpen] = useState(false);
const [selectedVersionId, setSelectedVersionId] = useState<string>('');

<VersionCompare
  pageId={pageId}
  versionId={selectedVersionId}
  isOpen={compareOpen}
  onClose={() => setCompareOpen(false)}
  onRestore={() => {
    // Refresh page content
    mutate();
  }}
/>
```

**Props:**
- `pageId: string` - Required. The page ID
- `versionId: string` - Required. The version ID to compare
- `isOpen: boolean` - Required. Dialog open state
- `onClose: () => void` - Required. Close handler
- `onRestore?: () => void` - Optional. Callback after successful restore

**API Endpoints:**
- `GET /api/pages/{pageId}/versions/{versionId}` - Get specific version
- `GET /api/pages/{pageId}` - Get current version
- `POST /api/pages/{pageId}/versions` - Restore version

---

### 4. AiOperationControls
Show AI operations linked to a message with undo functionality.

**Features:**
- Displays all pages modified by an AI message
- Shows operation status (COMPLETED, FAILED, etc.)
- Undo button to revert all AI changes
- Expandable/collapsible view
- Links to affected pages

**Usage:**
```tsx
import { AiOperationControls } from '@/components/ai/AiOperationControls';

// In MessageRenderer or ConversationMessageRenderer
{message.role === 'assistant' && message.id && (
  <AiOperationControls
    messageId={message.id}
    className="mt-2"
  />
)}
```

**Props:**
- `messageId: string` - Required. The AI message ID
- `className?: string` - Optional. Additional CSS classes

**API Endpoints:**
- `GET /api/ai/operations/by-message/{messageId}` - Get operations for message
- `POST /api/ai/operations/{operationId}/undo` - Undo an operation

---

### 5. Admin Audit Dashboard
Full admin interface for audit log management.

**Features:**
- Comprehensive filtering (category, action, user, drive, date range)
- Export to CSV or JSON
- Summary statistics (total events, AI vs human ratio, top users)
- Search within results
- Sortable data table

**Usage:**
```tsx
// Already implemented at /admin/audit
// Navigate to: /admin/audit
```

**Location:** `/home/user/PageSpace/apps/web/src/app/admin/audit/page.tsx`

**API Endpoint:** `GET /api/admin/audit/export`

---

## Integration Points

### 1. Add to Page Context Menu

```tsx
// In your page context menu component
import { PageHistory } from '@/components/audit';

<DropdownMenuItem onSelect={(e) => e.preventDefault()}>
  <PageHistory
    pageId={pageId}
    trigger={
      <div className="flex items-center w-full">
        <History className="h-4 w-4 mr-2" />
        View History
      </div>
    }
  />
</DropdownMenuItem>
```

### 2. Add to Drive Settings

```tsx
// In drive settings tabs
import { ActivityFeed } from '@/components/audit';

<Tabs defaultValue="general">
  <TabsList>
    <TabsTrigger value="general">General</TabsTrigger>
    <TabsTrigger value="members">Members</TabsTrigger>
    <TabsTrigger value="activity">Activity</TabsTrigger>
  </TabsList>

  <TabsContent value="activity">
    <ActivityFeed driveId={driveId} />
  </TabsContent>
</Tabs>
```

### 3. Add to Drive Sidebar

```tsx
// In drive sidebar component
import { ActivityFeed } from '@/components/audit';

<div className="space-y-4">
  <h3 className="font-semibold">Recent Activity</h3>
  <ActivityFeed
    driveId={driveId}
    showFilters={false}
    maxHeight="400px"
    limit={10}
  />
</div>
```

### 4. Integrate AI Controls into Chat

Update the message renderers to include AI operation controls:

```tsx
// In MessageRenderer.tsx or ConversationMessageRenderer.tsx
import { AiOperationControls } from '@/components/ai/AiOperationControls';

// After the message content
{message.role === 'assistant' && message.id && (
  <AiOperationControls messageId={message.id} className="mt-2" />
)}
```

### 5. Add to Admin Navigation

```tsx
// In admin layout navigation
<Link href="/admin/audit">
  <Shield className="h-4 w-4 mr-2" />
  Audit Log
</Link>
```

---

## State Management

All components use **SWR** for data fetching and caching:

- **ActivityFeed**: Auto-refreshes every 30 seconds
- **PageHistory**: Manual refresh on restore
- **VersionCompare**: Loads once on open
- **AiOperationControls**: Loads once, refreshes on undo
- **Admin Audit**: Manual refresh only

---

## Permission Requirements

- **ActivityFeed**: Requires drive membership
- **PageHistory**: Requires page view permission
- **VersionCompare**: Requires page view permission
- **Restore Version**: Requires page edit permission
- **Undo AI Operation**: User must own the AI operation
- **Admin Audit**: Requires admin role

---

## Styling

All components use:
- **shadcn/ui** components for consistency
- **Tailwind CSS** for styling
- **Dark mode** support via CSS variables
- **Responsive design** for mobile and desktop

---

## Real-time Updates

Components automatically update when:
- New audit events are created (ActivityFeed via SWR)
- Versions are restored (via mutate callbacks)
- AI operations complete (via SWR revalidation)

---

## Error Handling

All components include:
- Loading states with skeletons
- Error states with retry options
- Toast notifications for user actions
- Validation error messages

---

## Performance Considerations

- **Pagination**: ActivityFeed uses offset-based pagination
- **Lazy loading**: VersionCompare loads content only when opened
- **Memoization**: Components use React.memo where appropriate
- **Optimistic UI**: Restore actions show immediate feedback

---

## Example: Complete Integration

```tsx
'use client';

import { PageHistory } from '@/components/audit';
import { AiOperationControls } from '@/components/ai/AiOperationControls';
import { MessageRenderer } from '@/components/ai/MessageRenderer';

export function EnhancedPageView({ pageId, messages }) {
  return (
    <div>
      {/* Page toolbar with history */}
      <div className="flex justify-between items-center mb-4">
        <h1>Page Title</h1>
        <PageHistory pageId={pageId} />
      </div>

      {/* AI chat with operation controls */}
      <div className="space-y-4">
        {messages.map(message => (
          <div key={message.id}>
            <MessageRenderer message={message} />
            {message.role === 'assistant' && message.id && (
              <AiOperationControls messageId={message.id} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Testing

To test components:

```bash
# Start dev server
pnpm dev

# Test ActivityFeed
# Navigate to a drive and add to settings

# Test PageHistory
# Navigate to any page and add to toolbar

# Test Admin Audit
# Navigate to /admin/audit (requires admin role)

# Test AI Operations
# Send an AI message that modifies pages
# Check for the operation controls below the message
```

---

## API Reference

### Activity Feed API
```
GET /api/drives/{driveId}/activity
Query params:
  - limit: number (default: 50, max: 100)
  - offset: number (default: 0)
  - filter: string (action type)
  - fromDate: ISO 8601 date
  - toDate: ISO 8601 date
  - includeAi: boolean (default: true)
  - includeHuman: boolean (default: true)
```

### Page Versions API
```
GET /api/pages/{pageId}/versions
Query params:
  - limit: number (default: 50, max: 100)

GET /api/pages/{pageId}/versions/{versionId}
Returns full version with content

POST /api/pages/{pageId}/versions
Body: { versionNumber: number }
Requires CSRF token
```

### AI Operations API
```
GET /api/ai/operations/by-message/{messageId}
Returns operations with affected pages

POST /api/ai/operations/{operationId}/undo
Body: {}
Requires CSRF token
```

### Admin Audit API
```
GET /api/admin/audit/export
Query params:
  - format: 'json' | 'csv' (default: 'json')
  - category: string
  - actionType: string
  - userId: string
  - driveId: string
  - fromDate: ISO 8601 date
  - toDate: ISO 8601 date
  - limit: number (default: 1000, max: 10000)
```

---

## Troubleshooting

**ActivityFeed not updating:**
- Check SWR revalidation settings
- Verify drive access permissions
- Check browser console for API errors

**Version restore failing:**
- Ensure user has edit permission
- Check CSRF token is being sent
- Verify version belongs to the page

**AI operations not showing:**
- Verify messageId is correct
- Check that AI operation was tracked
- Ensure audit events were created

**Admin audit not accessible:**
- Verify user has admin role
- Check admin authentication middleware
- Ensure audit events exist in database
