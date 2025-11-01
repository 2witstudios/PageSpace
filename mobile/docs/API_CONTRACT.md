# PageSpace Mobile API Contract

This document defines the API contract between the PageSpace Swift mobile app and the PageSpace Next.js backend.

## Base URL

- **Development**: `http://localhost:3000/api`
- **Production**: `https://your-domain.com/api`

## Authentication

### Headers Required

All authenticated requests must include:

```http
Authorization: Bearer {jwt_token}
```

For write operations (POST, PATCH, DELETE), also include:

```http
X-CSRF-Token: {csrf_token}
```

### Token Management

- Tokens are obtained via `/api/auth/login`
- Tokens should be stored securely in iOS Keychain
- Token expiration is handled by backend (check `tokenVersion` field)
- On 401 response, client must re-authenticate

---

## Endpoints

### 1. Authentication

#### POST /api/auth/login

**Purpose**: Authenticate user and obtain JWT token

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response** (200 OK):
```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "John Doe",
    "createdAt": "2025-01-01T00:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "csrfToken": "csrf_token_here"
}
```

**Error Responses**:
- `401 Unauthorized`: Invalid credentials
- `429 Too Many Requests`: Rate limit exceeded

---

### 2. Conversations (Global AI)

#### GET /api/ai_conversations

**Purpose**: List all user conversations

**Query Parameters**:
- None (returns all active conversations)

**Response** (200 OK):
```json
{
  "conversations": [
    {
      "id": "conv_123",
      "userId": "user_123",
      "title": "Planning vacation",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-02T12:00:00.000Z",
      "isActive": true
    }
  ],
  "total": 1
}
```

---

#### GET /api/ai_conversations/global

**Purpose**: Get the user's global AI conversation (auto-created if doesn't exist)

**Response** (200 OK):
```json
{
  "id": "conv_global_user_123",
  "userId": "user_123",
  "title": "Global AI Assistant",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-02T12:00:00.000Z",
  "isActive": true
}
```

---

#### POST /api/ai_conversations

**Purpose**: Create a new conversation

**Request Body**:
```json
{
  "title": "New Project Discussion"
}
```

**Response** (201 Created):
```json
{
  "id": "conv_456",
  "userId": "user_123",
  "title": "New Project Discussion",
  "createdAt": "2025-01-03T00:00:00.000Z",
  "updatedAt": "2025-01-03T00:00:00.000Z",
  "isActive": true
}
```

---

#### GET /api/ai_conversations/{id}

**Purpose**: Get a specific conversation

**Response** (200 OK):
```json
{
  "id": "conv_123",
  "userId": "user_123",
  "title": "Planning vacation",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-02T12:00:00.000Z",
  "isActive": true
}
```

---

#### PATCH /api/ai_conversations/{id}

**Purpose**: Update conversation (e.g., rename)

**Request Body**:
```json
{
  "title": "Updated Title"
}
```

**Response** (200 OK):
```json
{
  "id": "conv_123",
  "userId": "user_123",
  "title": "Updated Title",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-03T14:00:00.000Z",
  "isActive": true
}
```

---

#### DELETE /api/ai_conversations/{id}

**Purpose**: Delete conversation (soft delete)

**Response** (200 OK):
```json
{
  "success": true
}
```

---

### 3. Messages

#### GET /api/ai_conversations/{id}/messages

**Purpose**: Load messages for a conversation

**Query Parameters**:
- `limit` (optional, default: 50): Number of messages to return
- `cursor` (optional): Pagination cursor
- `direction` (optional, default: "before"): "before" or "after"

**Response** (200 OK):
```json
{
  "messages": [
    {
      "id": "msg_123",
      "role": "user",
      "parts": [
        {
          "type": "text",
          "text": "Hello, how can you help me?"
        }
      ],
      "createdAt": "2025-01-01T10:00:00.000Z",
      "isActive": true
    },
    {
      "id": "msg_124",
      "role": "assistant",
      "parts": [
        {
          "type": "text",
          "text": "I can help you with many things! Let me search for information."
        },
        {
          "type": "tool-call",
          "toolCallId": "call_123",
          "toolName": "search_pages",
          "input": {
            "query": "example",
            "limit": 10
          }
        },
        {
          "type": "tool-result",
          "toolCallId": "call_123",
          "result": {
            "pages": [
              {"id": "page_1", "title": "Example Page"}
            ]
          },
          "isError": false
        },
        {
          "type": "text",
          "text": "I found 1 page matching your query."
        }
      ],
      "createdAt": "2025-01-01T10:00:05.000Z",
      "isActive": true
    }
  ],
  "pagination": {
    "hasMore": false,
    "nextCursor": null,
    "prevCursor": null,
    "limit": 50,
    "direction": "before"
  }
}
```

---

#### POST /api/ai_conversations/{id}/messages

**Purpose**: Send a message and stream AI response

**Request Body**:
```json
{
  "messages": [
    {
      "id": "msg_temp_123",
      "role": "user",
      "parts": [
        {
          "type": "text",
          "text": "What's the weather today?"
        }
      ],
      "createdAt": "2025-01-03T15:00:00.000Z",
      "isActive": true
    }
  ],
  "selectedProvider": "openrouter",
  "selectedModel": "anthropic/claude-3.5-sonnet",
  "locationContext": {
    "currentPage": {
      "id": "page_123",
      "title": "Project Notes",
      "type": "DOCUMENT",
      "path": "/projects/notes"
    },
    "currentDrive": {
      "id": "drive_123",
      "name": "My Workspace",
      "slug": "my-workspace"
    },
    "breadcrumbs": ["My Workspace", "Projects", "Notes"]
  },
  "agentRole": "PARTNER"
}
```

**Response**: Server-Sent Events (SSE) stream

**Content-Type**: `text/event-stream`

**Stream Format**:
```
event: message
data: {"type":"text-delta","index":0,"delta":{"text":"I"}}

event: message
data: {"type":"text-delta","index":0,"delta":{"text":" can"}}

event: message
data: {"type":"text-delta","index":0,"delta":{"text":" help"}}

event: message
data: {"type":"tool-call","toolCall":{"toolCallId":"call_456","toolName":"search_web","input":{"query":"weather today"}}}

event: message
data: {"type":"tool-result","toolResult":{"toolCallId":"call_456","result":{"temperature":"72°F","condition":"Sunny"},"isError":false}}

event: message
data: {"type":"text-delta","index":2,"delta":{"text":"The weather today is sunny with a temperature of 72°F."}}

event: finish
data: {"type":"finish"}
```

**Stream Event Types**:
- `text-delta`: Incremental text chunk
- `tool-call`: Tool invocation
- `tool-result`: Tool execution result
- `finish`: Stream complete

---

### 4. AI Settings

#### GET /api/ai/settings

**Purpose**: Get current AI provider and model configuration

**Response** (200 OK):
```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-3.5-sonnet",
  "apiKeys": {
    "openrouter": "sk-or-v1-***"
  }
}
```

---

#### PATCH /api/ai/settings

**Purpose**: Update AI provider/model selection

**Request Body**:
```json
{
  "provider": "google",
  "model": "gemini-2.0-flash-exp"
}
```

**Response** (200 OK):
```json
{
  "provider": "google",
  "model": "gemini-2.0-flash-exp",
  "apiKeys": {
    "google": "AIza***"
  }
}
```

---

## Message Parts Structure

Messages use a **parts-based structure** to support rich content:

### Text Part
```json
{
  "type": "text",
  "text": "Hello, world!"
}
```

### Tool Call Part
```json
{
  "type": "tool-call",
  "toolCallId": "call_123",
  "toolName": "read_page",
  "input": {
    "pageId": "page_456"
  }
}
```

### Tool Result Part
```json
{
  "type": "tool-result",
  "toolCallId": "call_123",
  "result": {
    "title": "Meeting Notes",
    "content": "..."
  },
  "isError": false
}
```

---

## Error Handling

### Standard Error Response
```json
{
  "error": "Error message here",
  "code": "ERROR_CODE",
  "details": {}
}
```

### Common Status Codes
- `200 OK`: Success
- `201 Created`: Resource created
- `400 Bad Request`: Invalid request body/params
- `401 Unauthorized`: Not authenticated or token expired
- `403 Forbidden`: Insufficient permissions or rate limit exceeded
- `404 Not Found`: Resource not found
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

---

## Rate Limiting

PageSpace enforces rate limits on AI requests:

- **Free tier**: 20 messages per day
- **Pro tier**: Unlimited

When rate limit is exceeded:
```json
{
  "error": "You've reached your daily message limit. Please upgrade to Pro for unlimited messages.",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

**Response Status**: `403 Forbidden`

---

## Real-time Updates (Socket.IO)

Connect to `ws://localhost:3001` (dev) or `wss://your-domain.com` (prod)

### Connection
```swift
socket.connect()
socket.emit("join_room", conversationId)
```

### Events to Listen For
- `new_message`: New message in conversation
- `typing`: User is typing
- `stop_typing`: User stopped typing

### Events to Emit
- `join_room`: Join conversation room
- `leave_room`: Leave conversation room
- `typing`: Indicate typing
- `stop_typing`: Stop typing indicator

---

## Mobile-Specific Considerations

1. **Background Requests**: iOS may terminate network requests when app backgrounds. Save state before backgrounding.

2. **Token Refresh**: JWT tokens expire - handle 401 responses by prompting re-authentication.

3. **Streaming Interruption**: If SSE stream disconnects, reload messages to get final state.

4. **Offline Mode**: Cache conversations and messages locally. Sync when online.

5. **Large Conversations**: Use pagination (`limit` + `cursor`) for conversations with 100+ messages.

---

## Testing Endpoints

Use tools like:
- **Postman**: Test HTTP requests
- **curl**: Command-line testing
- **Browser DevTools**: Monitor SSE streams

### Example curl Request
```bash
# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password"}'

# Get conversations
curl http://localhost:3000/api/ai_conversations \
  -H "Authorization: Bearer YOUR_TOKEN"

# Stream message
curl -X POST http://localhost:3000/api/ai_conversations/global/messages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","parts":[{"type":"text","text":"Hello"}]}]}'
```

---

## Versioning

Current API version: **v1** (implicit, no version prefix)

Breaking changes will introduce new versions (e.g., `/api/v2/...`)
