import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Admin API",
  description: "PageSpace admin API: user management, monitoring, notifications, and system diagnostics.",
  path: "/docs/api/admin",
  keywords: ["API", "admin", "monitoring", "notifications", "diagnostics"],
});

const content = `
# Admin API

Administrative endpoints for user management, monitoring, notifications, and system health.

## User Management

### GET /api/admin/users

List all users with statistics.

**Auth:** Admin role required.

**Response:**
\`\`\`json
[{
  "id": "string",
  "name": "string",
  "email": "string",
  "role": "user | admin",
  "driveCount": 3,
  "pageCount": 45,
  "messageCount": 120,
  "aiProvider": "string",
  "createdAt": "string"
}]
\`\`\`

---

### GET /api/admin/schema

Get database schema information for administrative tools.

**Auth:** Admin role required.

## Monitoring

### GET /api/monitoring/[metric]

System monitoring and analytics.

**Supported metrics:**
- \`system-health\` — Server status, uptime, memory
- \`api-metrics\` — Request counts, latency percentiles
- \`user-activity\` — Active users, session counts
- \`ai-usage\` — AI calls, tokens, costs by provider
- \`error-logs\` — Recent errors with stack traces
- \`performance\` — Database query times, cache hit rates

**Query params:** \`timeRange\` (1h, 24h, 7d, 30d)

**Auth:** Admin role required.

## Notifications

### GET /api/notifications

List notifications for the current user.

**Query params:** \`countOnly\` (boolean), \`limit\`, \`offset\`

**Response:**
\`\`\`json
{
  "notifications": [{
    "id": "string",
    "type": "string",
    "title": "string",
    "message": "string",
    "read": false,
    "createdAt": "string"
  }],
  "totalCount": 15,
  "unreadCount": 3
}
\`\`\`

---

### POST /api/notifications/[id]/read

Mark a notification as read.

---

### POST /api/notifications/read-all

Mark all notifications as read.

---

### DELETE /api/notifications/[id]

Delete a notification.

## Utility

### POST /api/track

Client-side event tracking for analytics.

**Body:**
\`\`\`json
{
  "event": "string",
  "properties": {}
}
\`\`\`

Fire-and-forget — always returns 200.

---

### DELETE /api/trash/[pageId]

Permanently delete a page from trash (irreversible).

---

### DELETE /api/trash/drives/[driveId]

Permanently delete a trashed drive.

---

### POST /api/contact

Submit a contact form or support request.

**Body:**
\`\`\`json
{
  "name": "string",
  "email": "string",
  "subject": "string",
  "message": "string"
}
\`\`\`
`;

export default function AdminApiPage() {
  return <DocsMarkdown content={content} />;
}
