# PageSpace Mobile AI Integration Guide

**Document Purpose**: Comprehensive guide for building a Swift mobile app that consumes PageSpace's AI chat functionality.

**Last Updated**: 2025-11-01
**Target Audience**: iOS/Swift developers building mobile clients for PageSpace

---

## Table of Contents

1. [AI Architecture Overview](#ai-architecture-overview)
2. [Message Streaming with Vercel AI SDK](#message-streaming-with-vercel-ai-sdk)
3. [Message Format and Structure](#message-format-and-structure)
4. [Agent Configuration and Communication](#agent-configuration-and-communication)
5. [API Endpoints for Mobile Clients](#api-endpoints-for-mobile-clients)
6. [Authentication and Authorization](#authentication-and-authorization)
7. [Implementation Examples](#implementation-examples)
8. [Real-time Collaboration](#real-time-collaboration)

---

## 1. AI Architecture Overview

PageSpace implements **TWO distinct AI conversation systems** that your mobile app must support:

### 1.1 Global AI (Global Conversations)
- **What**: User's personal AI assistant
- **Location**: Outside page hierarchy (accessible from dashboard/sidebar)
- **Database**: `conversations` + `messages` tables
- **Context**: Workspace-wide access
- **Use Case**: General-purpose AI assistance

### 1.2 Page AI (AI_CHAT Pages)
- **What**: Specialized AI conversations embedded within workspace
- **Location**: Within page hierarchy as `AI_CHAT` page type
- **Database**: `pages` + `chat_messages` tables
- **Context**: Location-specific (inherits from hierarchical position)
- **Use Case**: Project/feature-specific AI with custom configuration

### 1.3 Key Architectural Principles

**Database-First Architecture**:
- Every message is **immediately persisted** as a database row
- Database is the **single source of truth** for conversation history
- Streaming responses update the database on completion (via `onFinish` callback)
- Multiple users can interact with the same conversation

**Provider-Agnostic Design**:
- Centralized provider factory handles all AI providers
- Support for: OpenRouter, Google AI, OpenAI, Anthropic, xAI, Ollama, LM Studio, GLM
- 100+ models available through unified interface

**Permission-Based Context**:
- AI context is filtered by user permissions
- Only accessible pages/content included in AI context
- Tools filtered based on agent role and page configuration

---

## 2. Message Streaming with Vercel AI SDK

### 2.1 Streaming Implementation

PageSpace uses the **Vercel AI SDK v5** (`ai` package) for all streaming operations.

**Backend Streaming Pattern** (`/apps/web/src/app/api/ai/chat/route.ts`):

```typescript
import { streamText, convertToModelMessages } from 'ai';

// 1. Save user message immediately
await db.insert(chatMessages).values({
  id: messageId,
  pageId: chatId,
  conversationId,
  userId,
  role: 'user',
  content: messageContent,
  createdAt: new Date(),
  isActive: true,
});

// 2. Stream AI response
const result = streamText({
  model,
  system: systemPrompt,
  messages: modelMessages,
  tools: filteredTools,
  onFinish: async ({ responseMessage }) => {
    // 3. Save assistant message after streaming
    await saveMessageToDatabase({
      messageId: responseMessage.id,
      pageId: chatId,
      conversationId,
      userId: null, // AI message
      role: 'assistant',
      content: extractMessageContent(responseMessage),
      toolCalls: extractToolCalls(responseMessage),
      toolResults: extractToolResults(responseMessage),
      uiMessage: responseMessage, // Preserve part ordering
    });
  },
});

// 4. Return streaming response
return result.toUIMessageStreamResponse();
```

### 2.2 Stream Response Format

The backend returns a **Server-Sent Events (SSE)** stream in the Vercel AI SDK format:

**Stream Event Types**:
- `text`: Text content chunks
- `tool-call`: Tool invocation (name, arguments)
- `tool-result`: Tool execution result
- `data`: Metadata and additional information
- `finish`: Stream completion signal

**Example Stream Chunks**:
```
data: {"type":"text","text":"Let me "}

data: {"type":"text","text":"help you "}

data: {"type":"tool-call","toolCallId":"call_abc123","toolName":"read_page","args":{"pageId":"xyz789"}}

data: {"type":"tool-result","toolCallId":"call_abc123","result":{"content":"..."}}

data: {"type":"text","text":"Based on "}

data: {"type":"finish","usage":{"inputTokens":150,"outputTokens":75}}
```

### 2.3 Mobile Client Streaming Handling

For Swift, you'll need to:

1. **Use URLSession with SSE support** or a library like `EventSource`
2. **Parse JSON-encoded data chunks** line by line
3. **Reconstruct message parts** in order (text, tool calls, tool results)
4. **Update UI progressively** as chunks arrive
5. **Handle completion** on `finish` event

**Recommended Swift Library**: [ISSCEventSource](https://github.com/inaka/EventSource) for SSE parsing

---

## 3. Message Format and Structure

### 3.1 UIMessage Parts Structure

PageSpace uses a **parts-based message structure** (Vercel AI SDK format):

```typescript
interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  createdAt: Date;
  editedAt?: Date | null;
  messageType?: 'standard' | 'todo_list';
}

type MessagePart = TextPart | ToolPart;

interface TextPart {
  type: 'text';
  text: string;
}

interface ToolPart {
  type: string; // "tool-{toolName}"
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
}
```

### 3.2 Message Content Storage

**CRITICAL**: Messages are stored with **structured content** to preserve chronological ordering:

```json
{
  "textParts": [
    "Let me read that page for you.",
    "Based on the content, I recommend..."
  ],
  "partsOrder": [
    { "index": 0, "type": "text" },
    { "index": 1, "type": "tool-read_page", "toolCallId": "call_123" },
    { "index": 2, "type": "text" }
  ],
  "originalContent": "Let me read that page for you. Based on the content, I recommend..."
}
```

**Database Schema** (`chat_messages` table):
```sql
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,           -- Structured JSON or plain text
  tool_calls JSONB,                -- Array of tool calls
  tool_results JSONB,              -- Array of tool results
  created_at TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  agent_role TEXT DEFAULT 'PARTNER'
);
```

### 3.3 Mobile Rendering Implications

Your Swift app should:

1. **Parse `partsOrder`** to display content chronologically
2. **Render text parts** as markdown/rich text
3. **Render tool parts** as collapsible sections showing:
   - Tool name and arguments (input)
   - Tool execution result (output)
   - Execution status (state)
4. **Handle empty text parts** gracefully
5. **Support editing** (updates `editedAt` field)

**Swift Model Example**:
```swift
struct UIMessage: Codable, Identifiable {
    let id: String
    let role: MessageRole
    let parts: [MessagePart]
    let createdAt: Date
    let editedAt: Date?
    let messageType: MessageType
}

enum MessagePart: Codable {
    case text(TextPart)
    case tool(ToolPart)
}

struct TextPart: Codable {
    let type: String // "text"
    let text: String
}

struct ToolPart: Codable {
    let type: String // "tool-{toolName}"
    let toolCallId: String
    let toolName: String
    let input: [String: AnyCodable]?
    let output: AnyCodable?
    let state: ToolState
}

enum ToolState: String, Codable {
    case inputStreaming = "input-streaming"
    case inputAvailable = "input-available"
    case outputAvailable = "output-available"
    case outputError = "output-error"
}
```

---

## 4. Agent Configuration and Communication

### 4.1 Agent Roles

PageSpace supports **three agent roles** (legacy system, still functional):

| Role | Permissions | Use Case |
|------|------------|----------|
| **PARTNER** | Read + Write + Delete | Balanced conversational AI |
| **PLANNER** | Read-only | Strategic planning without execution |
| **WRITER** | Read + Write + Delete | Execution-focused, minimal chat |

**Note**: Page AI now supports **custom system prompts** and **tool filtering** instead of fixed roles.

### 4.2 Page AI Agent Configuration

Each `AI_CHAT` page can override:

```typescript
interface PageAgentConfig {
  systemPrompt?: string;          // Custom system prompt
  enabledTools?: string[];        // Filtered tool list
  aiProvider?: string;            // Override user's default provider
  aiModel?: string;               // Override user's default model
}
```

**API Endpoint**: `GET/PATCH /api/pages/{pageId}/agent-config`

**Example Response**:
```json
{
  "pageId": "clwx1234abcd",
  "systemPrompt": "You are a technical documentation assistant...",
  "enabledTools": ["read_page", "create_page", "list_pages"],
  "availableTools": [
    { "name": "read_page", "description": "Read page content" },
    { "name": "create_page", "description": "Create new page" },
    ...
  ],
  "aiProvider": "openai",
  "aiModel": "gpt-4-turbo"
}
```

### 4.3 Tool Availability

**PageSpace Tools** (`/apps/web/src/lib/ai/ai-tools.ts`):

Core tools available to AI agents:
- `list_drives` - List all accessible drives
- `list_pages` - List pages in a drive
- `read_page` - Read page content
- `create_page` - Create new page (FOLDER, DOCUMENT, AI_CHAT, CHANNEL, CANVAS)
- `rename_page` - Rename page
- `replace_lines` - Replace content lines
- `insert_lines` - Insert content
- `delete_lines` - Delete content lines
- `append_to_page` - Append content
- `prepend_to_page` - Prepend content
- `trash_page` - Delete page
- `trash_page_with_children` - Delete page recursively
- `restore_page` - Restore from trash
- `move_page` - Move/reorder pages
- `list_trash` - List trashed pages

**Tool Filtering**:
- Global AI: Tools filtered by agent role
- Page AI: Tools filtered by `enabledTools` configuration (or defaults to PARTNER role tools)

### 4.4 Agent-to-Agent Communication

Currently, PageSpace does not support **direct agent-to-agent communication**. Each AI conversation is isolated:
- Page AI agents operate independently
- Global AI is a separate conversation stream
- No built-in message passing between agents

**Future Enhancement**: Agent communication could be implemented via:
- Shared workspace context
- Message mentions (@mentions)
- Dedicated communication tools

---

## 5. API Endpoints for Mobile Clients

### 5.1 Global AI Endpoints

#### Get Global Conversation
```
GET /api/ai_conversations/global
```

**Response**:
```json
{
  "id": "conv_abc123",
  "title": "General Workspace Chat",
  "type": "global",
  "contextId": null,
  "lastMessageAt": "2025-11-01T10:30:00Z",
  "createdAt": "2025-11-01T09:00:00Z"
}
```

#### Get Conversation Messages
```
GET /api/ai_conversations/{conversationId}/messages
Query Params:
  - limit (default: 50, max: 200)
  - cursor (message ID for pagination)
  - direction (before | after)
```

**Response**:
```json
{
  "messages": [
    {
      "id": "msg_xyz789",
      "role": "user",
      "parts": [{ "type": "text", "text": "Hello!" }],
      "createdAt": "2025-11-01T10:00:00Z"
    },
    {
      "id": "msg_abc456",
      "role": "assistant",
      "parts": [
        { "type": "text", "text": "Hello! How can I help?" }
      ],
      "createdAt": "2025-11-01T10:00:05Z"
    }
  ],
  "pagination": {
    "hasMore": false,
    "nextCursor": null,
    "prevCursor": "msg_abc456",
    "limit": 50,
    "direction": "before"
  }
}
```

#### Send Message to Global AI
```
POST /api/ai_conversations/{conversationId}/messages
Content-Type: application/json
```

**Request Body**:
```json
{
  "messages": [
    {
      "id": "msg_new123",
      "role": "user",
      "parts": [{ "type": "text", "text": "What's in my workspace?" }]
    }
  ],
  "selectedProvider": "pagespace",
  "selectedModel": "glm-4.5-air",
  "locationContext": {
    "currentDrive": {
      "id": "drive_abc",
      "name": "Marketing",
      "slug": "marketing"
    },
    "breadcrumbs": ["Dashboard", "Marketing"]
  },
  "agentRole": "PARTNER"
}
```

**Response**: SSE stream (see section 2.2)

### 5.2 Page AI Endpoints

#### Get AI Chat Messages
```
GET /api/ai/chat/messages?pageId={pageId}
```

**Response**: Same format as Global AI messages

#### Send Message to Page AI
```
POST /api/ai/chat
Content-Type: application/json
```

**Request Body**:
```json
{
  "messages": [
    {
      "id": "msg_new456",
      "role": "user",
      "parts": [{ "type": "text", "text": "Create a project plan" }]
    }
  ],
  "chatId": "page_ai_chat_id",
  "conversationId": "conversation_session_id",
  "selectedProvider": "openai",
  "selectedModel": "gpt-4-turbo",
  "pageContext": {
    "pageId": "page_ai_chat_id",
    "pageTitle": "Project Planning AI",
    "pageType": "AI_CHAT",
    "pagePath": "/marketing/projects/project-alpha/planning-ai",
    "driveId": "drive_abc",
    "driveName": "Marketing",
    "driveSlug": "marketing",
    "breadcrumbs": ["Marketing", "Projects", "Project Alpha"]
  }
}
```

**Response**: SSE stream

### 5.3 AI Settings Endpoints

#### Get AI Settings
```
GET /api/ai/settings
```

**Response**:
```json
{
  "currentProvider": "pagespace",
  "currentModel": "glm-4.5-air",
  "userSubscriptionTier": "free",
  "providers": {
    "pagespace": { "isConfigured": true, "hasApiKey": true },
    "openrouter": { "isConfigured": false, "hasApiKey": false },
    "google": { "isConfigured": true, "hasApiKey": true },
    "openai": { "isConfigured": false, "hasApiKey": false },
    "anthropic": { "isConfigured": false, "hasApiKey": false }
  },
  "isAnyProviderConfigured": true
}
```

#### Save API Key
```
POST /api/ai/settings
Content-Type: application/json
```

**Request Body**:
```json
{
  "provider": "openai",
  "apiKey": "sk-..."
}
```

#### Update Provider/Model Selection
```
PATCH /api/ai/settings
Content-Type: application/json
```

**Request Body**:
```json
{
  "provider": "openai",
  "model": "gpt-4-turbo"
}
```

### 5.4 Page Agent Configuration Endpoints

#### Get Page Agent Config
```
GET /api/pages/{pageId}/agent-config
```

#### Update Page Agent Config
```
PATCH /api/pages/{pageId}/agent-config
Content-Type: application/json
```

**Request Body**:
```json
{
  "systemPrompt": "You are a technical writer assistant...",
  "enabledTools": ["read_page", "create_page", "replace_lines"],
  "aiProvider": "anthropic",
  "aiModel": "claude-3-5-sonnet-20241022"
}
```

---

## 6. Authentication and Authorization

### 6.1 Authentication Mechanism

PageSpace uses **JWT-based authentication** with CSRF protection.

**Auth Options** (from route handlers):
```typescript
const AUTH_OPTIONS = {
  allow: ['jwt', 'mcp'] as const,
  requireCSRF: true
};
```

### 6.2 Mobile Authentication Flow

1. **User Login** → `POST /api/auth/login`
   - Credentials: email + password
   - Response: JWT token + user data

2. **Store JWT** → Keychain/secure storage

3. **Include JWT in Requests**:
   ```
   Authorization: Bearer {jwt_token}
   X-CSRF-Token: {csrf_token}
   ```

4. **Token Refresh** → Handle 401 responses

**Login Endpoint**:
```
POST /api/auth/login
Content-Type: application/json
```

**Request**:
```json
{
  "email": "user@example.com",
  "password": "secure_password"
}
```

**Response**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "John Doe",
    "subscriptionTier": "free"
  }
}
```

### 6.3 Permission Checking

AI endpoints **automatically check permissions**:

**For Page AI** (`POST /api/ai/chat`):
```typescript
// Backend checks:
const canView = await canUserViewPage(userId, chatId);
const canEdit = await canUserEditPage(userId, chatId);

if (!canEdit) {
  return { error: 'No permission to send messages', status: 403 };
}
```

**For Global AI** (`POST /api/ai_conversations/{id}/messages`):
```typescript
// Backend checks:
const [conversation] = await db
  .select()
  .from(conversations)
  .where(and(
    eq(conversations.id, conversationId),
    eq(conversations.userId, userId),
    eq(conversations.isActive, true)
  ));

if (!conversation) {
  return { error: 'Conversation not found', status: 404 };
}
```

**Mobile Client**: Trust backend permission checks. Handle 403 errors gracefully.

### 6.4 Rate Limiting

PageSpace implements **usage-based rate limiting** for the `pagespace` provider:

**Rate Limits** (from `/apps/web/src/lib/subscription/rate-limit-middleware.ts`):
- **Free Tier**: 20 calls/day (standard model)
- **Pro Tier**: Unlimited standard + 100 pro calls/day
- **Business Tier**: Unlimited

**Backend Enforcement**:
```typescript
// Check BEFORE streaming
const currentUsage = await getCurrentUsage(userId, providerType);

if (currentUsage.remainingCalls <= 0) {
  return createRateLimitResponse(providerType, currentUsage.limit);
}
```

**Rate Limit Response**:
```json
{
  "error": "Rate limit exceeded",
  "rateLimitInfo": {
    "currentCount": 20,
    "limit": 20,
    "remainingCalls": 0,
    "resetAt": "2025-11-02T00:00:00Z"
  }
}
```

**Mobile Client**: Display rate limit errors and upgrade prompts.

---

## 7. Implementation Examples

### 7.1 Swift Service Layer

```swift
import Foundation

class PageSpaceAIService {
    private let baseURL = "https://your-instance.com"
    private let session: URLSession
    private var jwtToken: String?

    init(jwtToken: String) {
        self.jwtToken = jwtToken
        self.session = URLSession(configuration: .default)
    }

    // MARK: - Global AI

    func getGlobalConversation() async throws -> Conversation {
        let url = URL(string: "\(baseURL)/api/ai_conversations/global")!
        var request = URLRequest(url: url)
        request.addAuthHeaders(token: jwtToken)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw AIError.requestFailed
        }

        return try JSONDecoder().decode(Conversation.self, from: data)
    }

    func getMessages(conversationId: String, limit: Int = 50) async throws -> MessageResponse {
        var components = URLComponents(string: "\(baseURL)/api/ai_conversations/\(conversationId)/messages")!
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit))
        ]

        var request = URLRequest(url: components.url!)
        request.addAuthHeaders(token: jwtToken)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw AIError.requestFailed
        }

        return try JSONDecoder().decode(MessageResponse.self, from: data)
    }

    func sendMessage(
        conversationId: String,
        message: UIMessage,
        provider: String = "pagespace",
        model: String = "glm-4.5-air",
        locationContext: LocationContext? = nil
    ) -> AsyncThrowingStream<StreamChunk, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    let url = URL(string: "\(baseURL)/api/ai_conversations/\(conversationId)/messages")!
                    var request = URLRequest(url: url)
                    request.httpMethod = "POST"
                    request.addAuthHeaders(token: jwtToken)
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

                    let body = SendMessageRequest(
                        messages: [message],
                        selectedProvider: provider,
                        selectedModel: model,
                        locationContext: locationContext
                    )
                    request.httpBody = try JSONEncoder().encode(body)

                    let (bytes, response) = try await session.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse,
                          httpResponse.statusCode == 200 else {
                        throw AIError.requestFailed
                    }

                    for try await line in bytes.lines {
                        if line.hasPrefix("data: ") {
                            let jsonString = String(line.dropFirst(6))
                            if let data = jsonString.data(using: .utf8),
                               let chunk = try? JSONDecoder().decode(StreamChunk.self, from: data) {
                                continuation.yield(chunk)
                            }
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Page AI

    func sendPageMessage(
        chatId: String,
        conversationId: String,
        message: UIMessage,
        pageContext: PageContext
    ) -> AsyncThrowingStream<StreamChunk, Error> {
        // Similar to sendMessage but uses /api/ai/chat endpoint
        // Implementation omitted for brevity
    }

    // MARK: - Agent Configuration

    func getAgentConfig(pageId: String) async throws -> AgentConfig {
        let url = URL(string: "\(baseURL)/api/pages/\(pageId)/agent-config")!
        var request = URLRequest(url: url)
        request.addAuthHeaders(token: jwtToken)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw AIError.requestFailed
        }

        return try JSONDecoder().decode(AgentConfig.self, from: data)
    }

    func updateAgentConfig(pageId: String, config: AgentConfigUpdate) async throws {
        let url = URL(string: "\(baseURL)/api/pages/\(pageId)/agent-config")!
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.addAuthHeaders(token: jwtToken)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(config)

        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw AIError.requestFailed
        }
    }
}

// MARK: - URLRequest Extension

extension URLRequest {
    mutating func addAuthHeaders(token: String?) {
        if let token = token {
            setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        // Add CSRF token if needed
        setValue(UUID().uuidString, forHTTPHeaderField: "X-CSRF-Token")
    }
}

// MARK: - Models

struct SendMessageRequest: Codable {
    let messages: [UIMessage]
    let selectedProvider: String
    let selectedModel: String
    let locationContext: LocationContext?
}

struct StreamChunk: Codable {
    let type: String
    let text: String?
    let toolCallId: String?
    let toolName: String?
    let args: [String: AnyCodable]?
    let result: AnyCodable?
}

enum AIError: Error {
    case requestFailed
    case invalidResponse
    case rateLimitExceeded
}
```

### 7.2 SwiftUI View Example

```swift
import SwiftUI

struct ChatView: View {
    @StateObject private var viewModel: ChatViewModel
    @State private var messageText = ""

    var body: some View {
        VStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(viewModel.messages) { message in
                        MessageView(message: message)
                    }

                    if viewModel.isStreaming {
                        StreamingMessageView(chunks: viewModel.streamingChunks)
                    }
                }
                .padding()
            }

            HStack {
                TextField("Message", text: $messageText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)

                Button(action: sendMessage) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .disabled(messageText.isEmpty || viewModel.isStreaming)
            }
            .padding()
        }
        .navigationTitle(viewModel.conversationTitle)
        .task {
            await viewModel.loadMessages()
        }
    }

    private func sendMessage() {
        let message = UIMessage(
            id: UUID().uuidString,
            role: .user,
            parts: [.text(TextPart(type: "text", text: messageText))],
            createdAt: Date()
        )

        messageText = ""

        Task {
            await viewModel.sendMessage(message)
        }
    }
}

class ChatViewModel: ObservableObject {
    @Published var messages: [UIMessage] = []
    @Published var isStreaming = false
    @Published var streamingChunks: [StreamChunk] = []

    private let aiService: PageSpaceAIService
    private let conversationId: String

    var conversationTitle: String {
        // Derive from conversation or messages
        "AI Chat"
    }

    init(aiService: PageSpaceAIService, conversationId: String) {
        self.aiService = aiService
        self.conversationId = conversationId
    }

    @MainActor
    func loadMessages() async {
        do {
            let response = try await aiService.getMessages(conversationId: conversationId)
            messages = response.messages
        } catch {
            print("Failed to load messages: \(error)")
        }
    }

    @MainActor
    func sendMessage(_ message: UIMessage) async {
        messages.append(message)
        isStreaming = true
        streamingChunks = []

        do {
            let stream = aiService.sendMessage(
                conversationId: conversationId,
                message: message
            )

            for try await chunk in stream {
                streamingChunks.append(chunk)
            }

            // Convert streaming chunks to final message
            let assistantMessage = buildMessageFromChunks(streamingChunks)
            messages.append(assistantMessage)

            streamingChunks = []
            isStreaming = false
        } catch {
            print("Streaming error: \(error)")
            isStreaming = false
        }
    }

    private func buildMessageFromChunks(_ chunks: [StreamChunk]) -> UIMessage {
        var parts: [MessagePart] = []
        var currentText = ""

        for chunk in chunks {
            switch chunk.type {
            case "text":
                if let text = chunk.text {
                    currentText += text
                }
            case let toolType where toolType.hasPrefix("tool-"):
                // Add accumulated text
                if !currentText.isEmpty {
                    parts.append(.text(TextPart(type: "text", text: currentText)))
                    currentText = ""
                }
                // Add tool part
                if let toolCallId = chunk.toolCallId,
                   let toolName = chunk.toolName {
                    parts.append(.tool(ToolPart(
                        type: chunk.type,
                        toolCallId: toolCallId,
                        toolName: toolName,
                        input: chunk.args,
                        output: chunk.result,
                        state: .outputAvailable
                    )))
                }
            default:
                break
            }
        }

        // Add final text
        if !currentText.isEmpty {
            parts.append(.text(TextPart(type: "text", text: currentText)))
        }

        return UIMessage(
            id: UUID().uuidString,
            role: .assistant,
            parts: parts,
            createdAt: Date()
        )
    }
}
```

---

## 8. Real-time Collaboration

### 8.1 Socket.IO Integration

PageSpace uses **Socket.IO** for real-time collaboration (`apps/realtime` service, port 3001).

**Events Broadcast**:
- `message:created` - New message added
- `message:updated` - Message edited
- `message:deleted` - Message deleted (set `isActive = false`)
- `usage:updated` - Rate limit usage changed

### 8.2 Mobile Socket.IO Client

Use [Socket.IO Swift Client](https://github.com/socketio/socket.io-client-swift):

```swift
import SocketIO

class RealtimeService {
    private let manager: SocketManager
    private let socket: SocketIOClient

    init(serverURL: String, jwtToken: String) {
        manager = SocketManager(
            socketURL: URL(string: serverURL)!,
            config: [
                .log(true),
                .compress,
                .extraHeaders(["Authorization": "Bearer \(jwtToken)"])
            ]
        )
        socket = manager.defaultSocket
        setupHandlers()
    }

    private func setupHandlers() {
        socket.on("message:created") { [weak self] data, ack in
            guard let messageData = data.first as? [String: Any] else { return }
            self?.handleNewMessage(messageData)
        }

        socket.on("message:updated") { [weak self] data, ack in
            guard let messageData = data.first as? [String: Any] else { return }
            self?.handleMessageUpdate(messageData)
        }

        socket.on("usage:updated") { [weak self] data, ack in
            guard let usageData = data.first as? [String: Any] else { return }
            self?.handleUsageUpdate(usageData)
        }
    }

    func connect() {
        socket.connect()
    }

    func disconnect() {
        socket.disconnect()
    }

    func joinConversation(_ conversationId: String) {
        socket.emit("join:conversation", conversationId)
    }

    func leaveConversation(_ conversationId: String) {
        socket.emit("leave:conversation", conversationId)
    }

    private func handleNewMessage(_ data: [String: Any]) {
        // Parse and notify listeners
        NotificationCenter.default.post(
            name: .newMessageReceived,
            object: nil,
            userInfo: data
        )
    }

    private func handleMessageUpdate(_ data: [String: Any]) {
        // Update local message cache
    }

    private func handleUsageUpdate(_ data: [String: Any]) {
        // Update usage display
    }
}

extension Notification.Name {
    static let newMessageReceived = Notification.Name("newMessageReceived")
}
```

### 8.3 Optimistic Updates

For better UX, implement **optimistic updates**:

1. **Add message to local state immediately** when user sends
2. **Stream response in real-time**
3. **Update message ID** when server confirms persistence
4. **Rollback on error** with retry option

---

## Summary

Your Swift mobile app should:

1. **Authenticate** via JWT and include tokens in all requests
2. **Support both Global AI and Page AI** conversation types
3. **Parse SSE streams** from Vercel AI SDK format
4. **Reconstruct message parts** in chronological order
5. **Handle tool calls** with collapsible UI
6. **Respect permissions** enforced by backend
7. **Display rate limits** and upgrade prompts
8. **Connect to Socket.IO** for real-time updates
9. **Implement optimistic updates** for responsive UX

All AI endpoints are **database-first** - the backend is the source of truth. Your mobile app is a thin UI layer over the existing backend infrastructure.

---

## Next Steps

1. **Set up authentication** flow with JWT storage
2. **Implement SSE parsing** for streaming responses
3. **Build message UI components** for text and tool parts
4. **Add Socket.IO** for real-time collaboration
5. **Test with multiple AI providers** and agent configurations
6. **Handle error cases** (rate limits, permissions, network failures)

For questions or clarifications, refer to the PageSpace codebase:
- `/apps/web/src/app/api/ai/chat/route.ts` - Page AI implementation
- `/apps/web/src/app/api/ai_conversations/[id]/messages/route.ts` - Global AI implementation
- `/apps/web/src/lib/ai/provider-factory.ts` - Provider abstraction
- `/apps/web/src/lib/ai/assistant-utils.ts` - Message utilities
