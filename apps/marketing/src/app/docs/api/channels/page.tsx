import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Channels API",
  description: "PageSpace channels API: real-time messaging in channel pages.",
  path: "/docs/api/channels",
  keywords: ["API", "channels", "messaging", "real-time"],
});

const content = `
# Channels API

Real-time messaging in channel-type pages.

## Messages

### GET /api/channels/[pageId]/messages

List messages in a channel page.

**Query params:** \`limit\`, \`before\` (cursor-based pagination)

**Response:**
\`\`\`json
[{
  "id": "string",
  "userId": "string",
  "userName": "string",
  "content": "string",
  "createdAt": "string",
  "attachments": []
}]
\`\`\`

**Auth:** View permission on the page.

---

### POST /api/channels/[pageId]/messages

Send a message to a channel.

**Body:**
\`\`\`json
{
  "content": "string",
  "attachments": []
}
\`\`\`

**Auth:** Edit permission on the page.

**Side effects:** Message is broadcast via Socket.IO to all users in the channel room. If the message @mentions an AI agent, the agent is triggered to respond.

## Real-Time Events

Channel messages are delivered in real-time via Socket.IO:

- \`new_message\` — A new message was sent
- \`message_updated\` — A message was edited
- \`typing\` — A user is typing
- \`presence\` — User joined/left the channel

Clients join a Socket.IO room for each channel page they're viewing. The realtime service handles room management and message broadcasting.
`;

export default function ChannelsApiPage() {
  return <DocsMarkdown content={content} />;
}
