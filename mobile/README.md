# PageSpace Mobile - Swift iOS Companion App

## Overview

PageSpace Mobile is a native iOS companion app that provides a streamlined interface for interacting with PageSpace's AI chat system. This app is a **thin UI layer** - all AI processing, tool execution, and data persistence happens on the PageSpace backend.

## Architecture

### Design Principles

1. **Backend-First**: The Next.js server is the source of truth
2. **Streaming-Native**: Built around Server-Sent Events (SSE) for real-time AI responses
3. **Parts-Based Rendering**: Messages use a parts structure (text, tool-calls, tool-results)
4. **Offline-Aware**: Cache conversations locally, sync when online
5. **SwiftUI-Native**: Modern declarative UI with Combine for reactive programming

### Tech Stack

- **Language**: Swift 5.9+
- **UI Framework**: SwiftUI
- **Networking**: URLSession + async/await
- **Real-time**: EventSource (SSE) + Socket.IO Swift client
- **Persistence**: SwiftData (iOS 17+) or Core Data
- **Authentication**: JWT tokens with Keychain storage

### App Structure

```
PageSpaceMobile/
├── App/
│   ├── PageSpaceMobileApp.swift          # App entry point
│   └── Configuration/                    # Environment config
├── Core/
│   ├── Networking/
│   │   ├── APIClient.swift               # Base HTTP client
│   │   ├── APIEndpoints.swift            # Endpoint definitions
│   │   ├── AuthManager.swift             # JWT authentication
│   │   └── SSEClient.swift               # Server-Sent Events handler
│   ├── Models/
│   │   ├── Message.swift                 # Message & MessagePart models
│   │   ├── Conversation.swift            # Conversation model
│   │   ├── User.swift                    # User profile
│   │   └── PageContext.swift             # Page/Drive context
│   └── Services/
│       ├── AIService.swift               # AI chat operations
│       ├── ConversationService.swift     # Conversation CRUD
│       ├── RealtimeService.swift         # Socket.IO integration
│       └── SettingsService.swift         # AI settings management
├── Features/
│   ├── Auth/
│   │   ├── LoginView.swift
│   │   └── LoginViewModel.swift
│   ├── Conversations/
│   │   ├── ConversationListView.swift
│   │   ├── ConversationViewModel.swift
│   │   └── ConversationListViewModel.swift
│   ├── Chat/
│   │   ├── ChatView.swift                # Main chat interface
│   │   ├── ChatViewModel.swift           # Chat state management
│   │   ├── MessageRow.swift              # Individual message UI
│   │   ├── MessagePartView.swift         # Renders text/tools
│   │   └── StreamingIndicator.swift     # Typing/streaming UI
│   └── Settings/
│       ├── SettingsView.swift
│       └── ProviderSelectionView.swift
├── Shared/
│   ├── Components/
│   │   ├── LoadingView.swift
│   │   ├── ErrorView.swift
│   │   └── MarkdownText.swift            # Markdown rendering
│   └── Extensions/
│       ├── String+Markdown.swift
│       └── Date+Formatting.swift
└── Resources/
    ├── Assets.xcassets
    └── Info.plist
```

## Key Features (MVP)

### Phase 1: Core AI Chat
- ✅ Authentication (login with JWT)
- ✅ Global AI conversations (create, list, view)
- ✅ Send messages with SSE streaming
- ✅ Render message parts (text + tool calls)
- ✅ Message history with pagination

### Phase 2: Enhanced UX
- ⬜ Offline mode with local caching
- ⬜ Real-time sync with Socket.IO
- ⬜ Push notifications for new messages
- ⬜ AI provider/model selection
- ⬜ Conversation search

### Phase 3: Advanced Features (Future)
- ⬜ Page AI integration (browse drives/pages)
- ⬜ Voice input with Whisper
- ⬜ Image uploads for vision models
- ⬜ Multi-agent orchestration UI
- ⬜ Widgets and app shortcuts

## API Integration

### Authentication Flow

1. User enters email + password in `LoginView`
2. POST `/api/auth/login` → Receive JWT token
3. Store token in Keychain via `AuthManager`
4. Include `Authorization: Bearer {token}` in all requests
5. Include `X-CSRF-Token` header for write operations

### Message Streaming Flow

1. User types message in `ChatView`
2. `ChatViewModel` calls `AIService.sendMessage()`
3. Backend saves user message immediately
4. SSE stream opens, chunks arrive progressively
5. `MessagePartView` updates in real-time as parts arrive
6. Stream ends with `finish` event, message saved

### Data Models

```swift
struct Message: Identifiable, Codable {
    let id: String
    let role: MessageRole
    let parts: [MessagePart]
    let createdAt: Date
}

enum MessagePart {
    case text(String)
    case toolCall(ToolCall)
    case toolResult(ToolResult)
}

struct ToolCall {
    let id: String
    let name: String
    let input: [String: Any]
}

struct ToolResult {
    let id: String
    let output: [String: Any]
    let isError: Bool
}
```

## Development Setup

1. Install Xcode 15+
2. Open `PageSpaceMobile.xcodeproj`
3. Configure backend URL in `Configuration/Environment.swift`
4. Run on simulator or device

## Dependencies

### Swift Package Manager

```swift
dependencies: [
    .package(url: "https://github.com/socketio/socket.io-client-swift", from: "16.0.0"),
    .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.0.0"),
    .package(url: "https://github.com/apple/swift-async-algorithms", from: "1.0.0")
]
```

## Testing

```bash
# Run unit tests
xcodebuild test -scheme PageSpaceMobile -destination 'platform=iOS Simulator,name=iPhone 15'

# Run UI tests
xcodebuild test -scheme PageSpaceMobile -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:PageSpaceMobileUITests
```

## Build & Deploy

```bash
# Development build
xcodebuild -scheme PageSpaceMobile -configuration Debug

# TestFlight build
xcodebuild -scheme PageSpaceMobile -configuration Release archive

# App Store submission
xcodebuild -exportArchive -archivePath PageSpaceMobile.xcarchive -exportPath ./build -exportOptionsPlist ExportOptions.plist
```

## Contributing

See the main PageSpace [CONTRIBUTING.md](../CONTRIBUTING.md) for development guidelines.

## License

Same as PageSpace main project.
