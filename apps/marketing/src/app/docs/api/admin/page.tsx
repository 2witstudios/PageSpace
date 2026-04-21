import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Admin API",
  description: "PageSpace admin API: user management, audit logs, monitoring, notifications, and operational utilities.",
  path: "/docs/api/admin",
  keywords: ["API", "admin", "audit logs", "monitoring", "notifications"],
});

const content = `
# Admin API

Endpoints restricted to users with the \`admin\` role (\`withAdminAuth\`). Unless otherwise noted these require a session + CSRF token.

## User management

### GET /api/admin/users

List every user with rollup stats.

---

### POST /api/admin/users/create

Create a user account (admin-provisioning flow).

---

### GET /api/admin/users/[userId]/export

Export a user's data archive (for DSR requests).

---

### DELETE /api/admin/users/[userId]/data

Delete a user's data (the anonymization step of account removal).

---

### PUT /api/admin/users/[userId]/subscription

Override a user's subscription tier.

---

### POST /api/admin/users/[userId]/gift-subscription

Gift a subscription to a user.

---

### DELETE /api/admin/users/[userId]/gift-subscription

Revoke a previously gifted subscription.

## Audit logs

Append-only log of security-relevant events, hashed for integrity.

### GET /api/admin/audit-logs

List audit log entries. Supports filters (event type, actor, target, time range) — see the route handler for the canonical query param list.

---

### GET /api/admin/audit-logs/integrity

Verify the hash chain across the returned window.

---

### GET /api/admin/audit-logs/export

Stream an audit log export (CSV).

## Monitoring

### GET /api/monitoring/[metric]

System monitoring data.

**Supported metrics:**
- \`system-health\` — service status, uptime, memory
- \`api-metrics\` — request counts and latency percentiles
- \`user-activity\` — active users, sessions
- \`ai-usage\` — AI calls, tokens, and costs by provider
- \`error-logs\` — recent errors
- \`performance\` — \`responseTimes\` (hourly average/max/min), \`slowQueries\` (>5s endpoints), and per-endpoint \`metricTypes\` stats

**Query params:** \`range\` — \`24h\` (default), \`7d\`, \`30d\`, or \`all\`.

**Response:**
\`\`\`json
{
  "data": {},
  "range": "24h",
  "startDate": "string | null",
  "endDate": "string"
}
\`\`\`

## Notifications

Per-user in-app notifications. Read routes require a session; no admin role needed.

| Route | Method | Purpose |
|---|---|---|
| \`/api/notifications\` | GET | List notifications (\`countOnly=true\` returns counts only; supports \`limit\`, \`offset\`) |
| \`/api/notifications/[id]\` | DELETE | Delete a notification |
| \`/api/notifications/[id]/read\` | PATCH | Mark one notification read |
| \`/api/notifications/read-all\` | PATCH | Mark all notifications read |
| \`/api/notifications/push-tokens\` | GET | List the caller's push tokens |
| \`/api/notifications/push-tokens\` | POST | Register a push token |
| \`/api/notifications/push-tokens\` | DELETE | Unregister a push token |
| \`/api/notifications/unsubscribe/[token]\` | GET | One-click email unsubscribe (public) |

## Admin utilities

### GET /api/admin/schema

Introspect the PostgreSQL schema (used by internal tools).

---

### GET /api/admin/global-prompt

Return the complete context window sent to the AI — full system prompt, tool definitions, location context, and token estimates.

---

### GET /api/admin/contact

List submissions from the public \`/api/contact\` form.

## Trash management

### DELETE /api/trash/[pageId]

Permanently delete a trashed page (recursively). Session only, CSRF required.

---

### DELETE /api/trash/drives/[driveId]

Permanently delete a trashed drive. Session only; caller must be the drive owner.

## Public utilities

### POST /api/contact

Submit a contact form (no auth). Body:

\`\`\`json
{
  "name": "string",
  "email": "string",
  "subject": "string",
  "message": "string"
}
\`\`\`

---

### POST /api/track

Client-side event tracking. Fire-and-forget; always returns \`200\`.
`;

export default function AdminApiPage() {
  return <DocsMarkdown content={content} />;
}
