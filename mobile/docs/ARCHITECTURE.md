# PageSpace Mobile - Architecture Overview

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      PageSpace Mobile (iOS)                      │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     SwiftUI Views                           │ │
│  │  LoginView │ ConversationListView │ ChatView │ SettingsView│ │
│  └───────────────────────┬──────────────────────────────────────┘ │
│                          │ ObservableObject                       │
│  ┌───────────────────────▼──────────────────────────────────────┐ │
│  │                    ViewModels (State)                        │ │
│  │  LoginVM │ ConversationListVM │ ChatVM │ SettingsVM         │ │
│  └───────────────────────┬──────────────────────────────────────┘ │
│                          │ Calls                                  │
│  ┌───────────────────────▼──────────────────────────────────────┐ │
│  │                     Services (Business Logic)                │ │
│  │  AuthManager │ AIService │ ConversationService │ RealtimeService│
│  └───────────────────────┬──────────────────────────────────────┘ │
│                          │ Uses                                   │
│  ┌───────────────────────▼──────────────────────────────────────┐ │
│  │                 Networking Layer                             │ │
│  │  APIClient (HTTP) │ SSEClient (Streaming) │ Socket.IO       │ │
│  └───────────────────────┬──────────────────────────────────────┘ │
│                          │ Stores tokens                          │
│  ┌───────────────────────▼──────────────────────────────────────┐ │
│  │               iOS Keychain (Secure Storage)                  │ │
│  │  JWT Token │ CSRF Token                                      │ │
│  └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────┬───────────────────────────────────────┘
                            │ HTTPS/WSS
                            │
┌───────────────────────────▼───────────────────────────────────────┐
│                  PageSpace Backend (Next.js)                      │
│                                                                    │
│  ┌─────────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Web App        │  │  Realtime    │  │  Processor         │  │
│  │  (Port 3000)    │  │  (Port 3001) │  │  (Port 3003)       │  │
│  │                 │  │              │  │                    │  │
│  │ • API Routes    │  │ • Socket.IO  │  │ • File Processing │  │
│  │ • AI Streaming  │  │ • Live Sync  │  │ • Image Opt       │  │
│  │ • Auth          │  │ • Presence   │  │ • Content Extract │  │
│  └────────┬────────┘  └──────┬───────┘  └─────────┬──────────┘  │
│           │                  │                     │             │
│           └──────────────────┼─────────────────────┘             │
│                              │                                    │
│  ┌──────────────────────────▼────────────────────────────────┐  │
│  │              PostgreSQL Database                          │  │
│  │  users │ conversations │ messages │ pages │ drives        │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## Layer Responsibilities

### 1. **View Layer** (SwiftUI)

**Purpose**: User interface and user interaction

**Components**:
- `LoginView`: Email/password login form
- `ConversationListView`: List of AI conversations
- `ChatView`: Main chat interface with message history
- `MessageRow`: Individual message rendering
- `MessagePartView`: Polymorphic part rendering (text, tool-call, tool-result)
- `SettingsView`: AI provider/model configuration

**Characteristics**:
- Declarative UI with SwiftUI
- Reactive to `@Published` properties in ViewModels
- No direct network calls
- No business logic

---

### 2. **ViewModel Layer** (State Management)

**Purpose**: Presentation logic and UI state

**Components**:
- `LoginViewModel`: Login form state and validation
- `ConversationListViewModel`: Conversation list state
- `ChatViewModel`: Chat state, streaming message assembly
- `SettingsViewModel`: Settings form state

**Characteristics**:
- `@MainActor` for UI thread safety
- `ObservableObject` with `@Published` properties
- Calls service layer for data operations
- Transforms service responses into UI-friendly format

**Example**:
```swift
@MainActor
class ChatViewModel: ObservableObject {
    @Published var messages: [Message] = []
    @Published var isStreaming = false

    func sendMessage(_ text: String) async {
        // 1. Add user message to UI
        // 2. Call AIService to stream response
        // 3. Update UI progressively as chunks arrive
    }
}
```

---

### 3. **Service Layer** (Business Logic)

**Purpose**: Domain logic and API integration

**Components**:

#### `AuthManager` (Singleton)
- Login/logout
- Token storage in Keychain
- Token retrieval for authenticated requests
- Session state management

#### `AIService` (Singleton)
- Send messages with SSE streaming
- Load message history
- Parse SSE stream chunks
- Manage AI settings

#### `ConversationService` (Singleton)
- CRUD operations for conversations
- List conversations
- Get global conversation

#### `RealtimeService` (Singleton, Placeholder)
- Socket.IO connection management
- Join/leave rooms
- Typing indicators
- Real-time message sync

**Characteristics**:
- Singleton pattern for shared state
- `@MainActor` for UI updates
- `async/await` for network calls
- No SwiftUI dependencies (pure Swift)

---

### 4. **Networking Layer** (HTTP/SSE/WebSocket)

**Purpose**: Low-level network communication

**Components**:

#### `APIClient`
- Generic HTTP request handler
- JWT + CSRF token injection
- Response parsing with `Codable`
- Error handling (401, 403, 429, 500)
- SSE stream parsing

**Key Methods**:
```swift
func request<T: Decodable>(
    endpoint: String,
    method: HTTPMethod,
    body: (any Encodable)?
) async throws -> T

func streamRequest(
    endpoint: String,
    method: HTTPMethod,
    body: (any Encodable)?
) -> AsyncThrowingStream<SSEEvent, Error>
```

#### `APIEndpoints`
- Centralized endpoint definitions
- Type-safe URL construction

**Characteristics**:
- URLSession-based
- Automatic authentication header injection
- SSE stream parsing line-by-line
- Retry logic (future)

---

### 5. **Data Layer** (Models)

**Purpose**: Data structures and serialization

**Models**:

#### `Message`
- Represents a single message
- Contains array of `MessagePart` (polymorphic)
- `role`: user or assistant
- `createdAt`: timestamp

#### `MessagePart` (Enum)
- `.text(TextPart)`: Plain text
- `.toolCall(ToolCallPart)`: Tool invocation
- `.toolResult(ToolResultPart)`: Tool execution result

#### `Conversation`
- Represents a conversation
- Contains metadata (title, timestamps)

#### `User`
- User profile data
- Email, name, ID

**Characteristics**:
- `Codable` for JSON serialization
- `Identifiable` for SwiftUI lists
- `Equatable` for state comparison

---

## Data Flow

### 1. User Login Flow

```
User taps "Sign In"
     │
     ▼
LoginView → LoginViewModel.login()
     │
     ▼
AuthManager.login(email, password)
     │
     ▼
APIClient.request(POST /api/auth/login)
     │
     ▼
Backend validates credentials
     │
     ▼
Returns { user, token, csrfToken }
     │
     ▼
AuthManager stores tokens in Keychain
     │
     ▼
AuthManager.isAuthenticated = true
     │
     ▼
App shows MainTabView (reactive)
```

---

### 2. Message Sending Flow

```
User types message and taps send
     │
     ▼
ChatView calls ChatViewModel.sendMessage(text)
     │
     ▼
ChatViewModel creates user Message
     │
     ▼
ChatViewModel appends to messages array (UI updates)
     │
     ▼
ChatViewModel calls AIService.sendMessage()
     │
     ▼
AIService.sendMessage() returns AsyncThrowingStream
     │
     ▼
APIClient.streamRequest(POST /api/ai_conversations/{id}/messages)
     │
     ▼
Backend saves user message immediately
     │
     ▼
Backend streams AI response as SSE chunks
     │
     ▼
APIClient parses SSE line-by-line
     │
     ▼
AIService yields StreamChunk objects
     │
     ▼
ChatViewModel processes chunks:
  - text-delta → append to streaming message
  - tool-call → add tool call part
  - tool-result → add tool result part
  - finish → finalize message
     │
     ▼
ChatViewModel updates messages array (UI updates reactively)
     │
     ▼
Backend saves assistant message in onFinish callback
```

---

### 3. Authentication Flow

```
Every API request:
     │
     ▼
APIClient.request() or streamRequest()
     │
     ▼
addAuthHeaders() injects:
  - Authorization: Bearer {jwt}
  - X-CSRF-Token: {csrf} (for POST/PATCH/DELETE)
     │
     ▼
Backend authenticateRequestWithOptions()
     │
     ▼
Decode JWT and validate:
  - Signature valid?
  - User exists?
  - tokenVersion matches?
  - CSRF token valid? (for writes)
     │
     ▼
If valid: proceed with request
If invalid: return 401 Unauthorized
     │
     ▼
APIClient receives 401
     │
     ▼
APIClient calls AuthManager.logout()
     │
     ▼
App shows LoginView (reactive)
```

---

## Key Design Patterns

### 1. MVVM (Model-View-ViewModel)

**Benefits**:
- Clear separation of concerns
- Testable business logic (ViewModels)
- Reactive UI updates with Combine

**Example**:
```swift
// Model
struct Message: Codable { ... }

// ViewModel
@MainActor
class ChatViewModel: ObservableObject {
    @Published var messages: [Message] = []
    func sendMessage() { ... }
}

// View
struct ChatView: View {
    @StateObject var viewModel: ChatViewModel
    var body: some View {
        ForEach(viewModel.messages) { message in
            MessageRow(message: message)
        }
    }
}
```

---

### 2. Singleton Services

**Purpose**: Shared state across app

**Services**:
- `AuthManager.shared`
- `AIService.shared`
- `ConversationService.shared`
- `RealtimeService.shared`

**Benefits**:
- Single source of truth
- Easy access from any ViewModel
- Centralized state management

---

### 3. Async/Await for Network Calls

**Purpose**: Modern concurrency

**Example**:
```swift
func loadMessages() async throws -> [Message] {
    let response: ConversationMessagesResponse = try await apiClient.request(
        endpoint: "/api/ai_conversations/\(id)/messages"
    )
    return response.messages
}
```

**Benefits**:
- Cleaner than callbacks
- Native error propagation
- Structured concurrency

---

### 4. AsyncThrowingStream for SSE

**Purpose**: Progressive data streaming

**Example**:
```swift
func sendMessage() -> AsyncThrowingStream<StreamChunk, Error> {
    AsyncThrowingStream { continuation in
        Task {
            for try await event in sseStream {
                let chunk = parseChunk(event)
                continuation.yield(chunk)
            }
            continuation.finish()
        }
    }
}
```

**Benefits**:
- Backpressure handling
- Cancellation support
- Type-safe streaming

---

### 5. Polymorphic Message Parts

**Purpose**: Flexible message content

**Design**:
```swift
enum MessagePart: Codable {
    case text(TextPart)
    case toolCall(ToolCallPart)
    case toolResult(ToolResultPart)
}
```

**Benefits**:
- Single message can contain mixed content
- Type-safe part handling
- Easy to extend with new part types

---

## Security Considerations

### 1. Token Storage

- ✅ Keychain (encrypted by iOS)
- ❌ UserDefaults (plaintext, insecure)
- ❌ In-memory only (lost on app kill)

### 2. HTTPS Enforcement

- Development: HTTP allowed for `localhost`
- Production: HTTPS enforced via `NSAppTransportSecurity`

### 3. Certificate Pinning (Future)

Prevent man-in-the-middle attacks by pinning SSL certificates.

---

## Performance Optimizations

### 1. Message Pagination

Load messages in chunks (50 at a time) to avoid large payloads:
```swift
let response = try await aiService.loadMessages(
    conversationId: id,
    limit: 50,
    cursor: pagination.nextCursor
)
```

### 2. SwiftUI List Virtualization

`LazyVStack` only renders visible messages:
```swift
ScrollView {
    LazyVStack {
        ForEach(messages) { message in
            MessageRow(message: message)
        }
    }
}
```

### 3. Streaming Message Assembly

Update UI progressively as chunks arrive (no buffering):
```swift
for try await chunk in stream {
    streamingMessage.appendText(chunk.delta.text)
    updateUI()  // Immediate update
}
```

---

## Offline Mode (Future)

### Architecture

```
┌────────────────────────────────────────┐
│         Mobile App                     │
│                                        │
│  ┌──────────────────────────────────┐ │
│  │       SwiftData / Core Data       │ │
│  │  (Local cache of conversations)   │ │
│  └──────────────────────────────────┘ │
│                 │                      │
│  ┌──────────────▼───────────────────┐ │
│  │       Sync Manager                │ │
│  │  • Queue pending messages         │ │
│  │  • Detect online/offline          │ │
│  │  • Conflict resolution            │ │
│  └──────────────┬───────────────────┘ │
└─────────────────┼──────────────────────┘
                  │
      ┌───────────▼───────────┐
      │  Online?              │
      │  Yes → Sync to backend│
      │  No → Store locally   │
      └───────────────────────┘
```

**Implementation**:
1. SwiftData for local persistence
2. Sync queue for pending operations
3. Conflict resolution (last-write-wins or manual)
4. Background sync when app becomes active

---

## Real-time Sync (Future)

### Architecture

```
┌────────────────────────────────────────┐
│         Mobile App                     │
│                                        │
│  ┌──────────────────────────────────┐ │
│  │      RealtimeService             │ │
│  │  • Socket.IO client               │ │
│  │  • Join conversation rooms        │ │
│  │  • Listen for new_message events │ │
│  └──────────────┬───────────────────┘ │
└─────────────────┼──────────────────────┘
                  │ WebSocket
                  │
┌─────────────────▼──────────────────────┐
│  Realtime Service (Port 3001)          │
│                                        │
│  • Broadcast new_message to room       │
│  • Handle typing indicators            │
│  • Presence tracking                   │
└────────────────────────────────────────┘
```

**Implementation**:
1. Socket.IO Swift client (already in dependencies)
2. Room-based messaging (one room per conversation)
3. Event handling: `new_message`, `typing`, `stop_typing`
4. Auto-reconnect on network changes

---

## Testing Strategy

### Unit Tests
- ViewModels (business logic)
- Services (API integration)
- Models (serialization)

### Integration Tests
- End-to-end message flow
- Authentication flow
- Streaming message assembly

### UI Tests (Future)
- Login flow
- Message sending
- Conversation navigation

---

## Future Enhancements

### Phase 2
- [ ] Offline mode with SwiftData
- [ ] Real-time sync with Socket.IO
- [ ] Push notifications
- [ ] AI provider/model selection UI

### Phase 3
- [ ] Page AI integration (browse drives/pages)
- [ ] Voice input with Whisper API
- [ ] Image uploads for vision models
- [ ] Multi-agent orchestration UI
- [ ] Widgets and app shortcuts

---

## Conclusion

The PageSpace mobile architecture is designed for:

✅ **Simplicity**: Thin UI layer over existing backend
✅ **Scalability**: Services can be extended without UI changes
✅ **Testability**: Clear layer separation enables unit testing
✅ **Performance**: Streaming + lazy loading for responsiveness
✅ **Security**: Keychain storage + HTTPS + JWT authentication

This architecture balances pragmatism (leverage existing backend) with best practices (MVVM, async/await, SwiftUI).
