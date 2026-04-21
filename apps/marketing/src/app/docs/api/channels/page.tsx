import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Channels API",
  description: "PageSpace channels API: real-time messaging, reactions, file uploads, and read state on channel pages.",
  path: "/docs/api/channels",
  keywords: ["API", "channels", "messaging", "real-time", "reactions"],
});

const content = `
# Channels API

Real-time messaging on \`CHANNEL\` pages. New messages are persisted and broadcast via Socket.IO to all users in the channel room.

## Messages

### GET /api/channels/[pageId]/messages

List messages in a channel, newest-first with cursor pagination.

**Query params:**
- \`limit\` — 1-200, default 50
- \`cursor\` — composite cursor returned by a previous call as \`nextCursor\`

**Response:**
\`\`\`json
{
  "messages": [{
    "id": "string",
    "pageId": "string",
    "userId": "string",
    "content": "string",
    "fileId": "string | null",
    "createdAt": "string",
    "user": { "id": "string", "name": "string", "image": "string | null" },
    "file": { "id": "string", "mimeType": "string", "sizeBytes": 0 },
    "reactions": []
  }],
  "nextCursor": "ISO-date|id or null",
  "hasMore": true
}
\`\`\`

Messages are returned oldest-first within each page for display. **Auth:** view permission on the page.

---

### POST /api/channels/[pageId]/messages

Send a message to a channel.

**Body:**
\`\`\`json
{
  "content": "string",
  "fileId": "string",
  "attachmentMeta": {
    "originalName": "string",
    "size": 0,
    "mimeType": "string",
    "contentHash": "string"
  }
}
\`\`\`

Attach a previously uploaded file by setting \`fileId\`. **Auth:** edit permission on the page.

**Side effects:** broadcasts \`new_message\` via Socket.IO, triggers inbox updates for drive members with view access, and starts agent responses for any \`@\`-mentioned AI agents.

## Reactions

### POST /api/channels/[pageId]/messages/[messageId]/reactions

Add an emoji reaction to a message.

---

### DELETE /api/channels/[pageId]/messages/[messageId]/reactions

Remove the current user's reaction.

## Read state

### POST /api/channels/[pageId]/read

Mark the channel as read for the current user up to the latest message.

## Attachments

### POST /api/channels/[pageId]/upload

Upload a file directly into a channel. Accepts \`multipart/form-data\` and creates an attached message.

## Real-time events

Clients join a Socket.IO room for each channel they view. The realtime service broadcasts:

| Event | Payload |
|---|---|
| \`new_message\` | The full message record |
| \`message_updated\` | The updated message |
| \`message_deleted\` | \`{ messageId }\` |
| \`reaction_added\` / \`reaction_removed\` | Reaction payload |
| \`typing\` | \`{ userId }\` |

Event names follow the pattern shown above; additional events may be added over time.
`;

export default function ChannelsApiPage() {
  return <DocsMarkdown content={content} />;
}
