import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI API",
  description: "PageSpace AI API: chat streaming, provider settings, global conversations, page agents, and model configuration.",
  path: "/docs/api/ai",
  keywords: ["API", "AI", "chat", "streaming", "providers", "agents", "conversations"],
});

const content = `
# AI API

Chat streaming, provider settings, global conversations, and page agent management.

## Chat

### POST /api/ai/chat

Stream an AI response. The primary AI endpoint.

**Body:**
\`\`\`json
{
  "pageId": "string",
  "message": "string",
  "provider": "string (optional)",
  "model": "string (optional)"
}
\`\`\`

**Response:** Server-sent event stream with AI response chunks, tool calls, and tool results.

**Auth:** Edit permission on the page.

---

### GET /api/ai/chat

Check provider configuration status for the current user.

---

### PATCH /api/ai/chat

Update page-specific AI settings (provider, model).

**Body:**
\`\`\`json
{
  "pageId": "string",
  "aiProvider": "string",
  "aiModel": "string"
}
\`\`\`

**Auth:** Edit permission on the page.

---

### GET /api/ai/chat/messages

Load chat messages for a page in chronological order, including tool calls and results.

**Query params:** \`pageId\`

**Auth:** View permission on the page.

## Provider Settings

### GET /api/ai/settings

Check AI provider configuration status.

---

### POST /api/ai/settings

Save API key for a provider.

**Body:**
\`\`\`json
{
  "provider": "openrouter | google | openai | anthropic | xai",
  "apiKey": "string",
  "baseUrl": "string (optional)"
}
\`\`\`

API keys are encrypted before storage.

---

### PATCH /api/ai/settings

Update current provider/model selection.

---

### DELETE /api/ai/settings

Remove API key for a provider.

## Global Conversations

### GET /api/ai/global

List the user's global AI conversations.

---

### POST /api/ai/global

Create a new global AI conversation.

---

### GET /api/ai/global/[id]

Get a specific global conversation.

---

### PATCH /api/ai/global/[id]

Update conversation metadata.

---

### DELETE /api/ai/global/[id]

Delete a global conversation.

---

### GET /api/ai/global/[id]/messages

List messages in a global conversation.

---

### POST /api/ai/global/[id]/messages

Send a message in a global conversation (streams AI response).

---

### DELETE /api/ai/global/[id]/messages/[messageId]

Delete a specific message.

---

### GET /api/ai/global/[id]/usage

Get AI usage statistics for a conversation.

---

### GET /api/ai/global/active

Get the most recent active global conversation.

## Page Agents

### POST /api/ai/page-agents/create

Create a new page-based AI agent.

---

### GET /api/ai/page-agents/[agentId]/config

Get agent configuration.

---

### PATCH /api/ai/page-agents/[agentId]/config

Update agent configuration.

---

### GET /api/ai/page-agents/[agentId]/conversations

List conversations for a page agent.

---

### POST /api/ai/page-agents/[agentId]/conversations

Create a new conversation with a page agent.

---

### POST /api/ai/page-agents/consult

Consult a page agent (agent-to-agent communication).

**Body:**
\`\`\`json
{
  "agentId": "string",
  "question": "string",
  "context": "string (optional)"
}
\`\`\`

---

### GET /api/ai/page-agents/multi-drive

List all page agents across multiple drives.

## Ollama

### GET /api/ai/ollama/models

List available Ollama models for local AI processing.
`;

export default function AiApiPage() {
  return <DocsMarkdown content={content} />;
}
