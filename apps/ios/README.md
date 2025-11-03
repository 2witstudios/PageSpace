# PageSpace iOS App

Native iOS companion app for PageSpace, built with SwiftUI and targeting iOS 17+.

## 📱 Features

- **Authentication**: JWT-based auth with secure Keychain storage
- **Global AI Assistant**: Personal AI chat accessible anywhere
- **Page AI Agents**: Specialized agents per workspace with context
- **Agent Management**: Browse, create, and switch between AI agents
- **Real-time Sync**: Socket.IO integration for live updates
- **Streaming Responses**: Server-Sent Events (SSE) for AI chat
- **Tool Calling**: Visualization of AI tool usage

## 🏗️ Architecture

```
PageSpace/
├── PageSpaceApp.swift           # App entry point with auth routing
├── App/
│   └── Configuration/
│       └── AppEnvironment.swift # API endpoints configuration
├── Core/
│   ├── Networking/
│   │   ├── APIClient.swift      # HTTP + SSE client
│   │   ├── APIEndpoints.swift   # Endpoint definitions
│   │   └── AuthManager.swift    # JWT authentication
│   ├── Models/
│   │   ├── Message.swift        # Message + MessagePart models
│   │   ├── Conversation.swift   # Conversation models
│   │   ├── User.swift           # User + auth models
│   │   └── Page.swift           # Page, Drive, Agent models
│   └── Services/
│       ├── AIService.swift      # AI chat operations
│       ├── AgentService.swift   # Agent management
│       ├── ConversationService.swift
│       ├── PageAIService.swift
│       └── RealtimeService.swift # Socket.IO (placeholder)
├── Features/
│   ├── Auth/
│   │   ├── LoginView.swift
│   │   └── LoginViewModel.swift
│   ├── Agents/
│   │   ├── AgentListView.swift
│   │   └── AgentPickerView.swift
│   ├── Conversations/
│   │   ├── ConversationListView.swift
│   │   └── ConversationListViewModel.swift
│   ├── Chat/
│   │   ├── ChatView.swift
│   │   ├── ChatViewModel.swift
│   │   ├── UnifiedChatView.swift
│   │   ├── UnifiedChatViewModel.swift
│   │   ├── MessageRow.swift
│   │   └── QuickChatView.swift
│   └── Settings/
│       └── SettingsView.swift
└── Info.plist
```

## 🔧 Setup

### Prerequisites

- macOS with Xcode 15+
- iOS 17+ Simulator or Device
- PageSpace backend running on `http://localhost:3000`

### Installation

1. **Open the project**:
   ```bash
   cd apps/ios
   open PageSpace.xcodeproj
   ```

2. **Dependencies are managed via Swift Package Manager**:
   - `socket.io-client-swift` (v16.0.0+) - Real-time Socket.IO
   - `swift-markdown-ui` (v2.0.0+) - Markdown rendering
   - `swift-async-algorithms` (v1.0.0+) - Stream processing

3. **Select your target**:
   - Scheme: PageSpace
   - Destination: iPhone 16 (or any iOS 17+ simulator)

4. **Build & Run**:
   - Press `Cmd + R` or click the Play button

## 🌐 Backend Configuration

The app is configured to connect to your local PageSpace backend:

**Development** (default):
- API: `http://localhost:3000`
- Realtime: `http://localhost:3001`

**Production**:
- Update URLs in `App/Configuration/AppEnvironment.swift`

### Starting the Backend

```bash
# In the PageSpace root directory
pnpm dev  # Starts web (3000), realtime (3001), processor (3003)
```

## 🔑 Authentication Flow

1. User enters credentials in `LoginView`
2. `AuthManager` sends POST to `/api/auth/login`
3. JWT token stored securely in Keychain
4. Token included in all API requests via `Authorization` header
5. CSRF token obtained and used for write operations

## 💬 AI Chat Features

### Global AI Assistant
- Personal AI chat available everywhere
- Persistent conversation history
- Streaming responses via SSE
- Tool calling support

### Page AI Agents
- Context-aware agents per workspace
- Agent switching with preserved context
- Specialized tools for page operations

## 🔌 Real-time Integration

The app includes Socket.IO setup for future real-time features:
- Live page updates
- Collaborative editing
- Presence indicators
- Typing indicators

Currently configured but not fully active - backend Socket.IO integration in progress.

## 🧪 Testing

```bash
# Run tests
Cmd + U in Xcode

# Or via command line
xcodebuild test -scheme PageSpace -destination 'platform=iOS Simulator,name=iPhone 16'
```

## 📦 Build & Distribution

### Development Build
```bash
xcodebuild -scheme PageSpace -configuration Debug
```

### Release Build
```bash
xcodebuild -scheme PageSpace -configuration Release
```

### Archive for App Store
1. Product → Archive in Xcode
2. Organizer → Distribute App
3. Follow App Store Connect workflow

## 🐛 Troubleshooting

### Connection Issues

**Problem**: "Cannot connect to localhost:3000"

**Solution**:
1. Verify backend is running: `pnpm dev`
2. Check `NSAppTransportSecurity` settings in Info.plist
3. Ensure simulator/device can reach localhost

### Build Errors

**Problem**: "No such module 'SocketIO'"

**Solution**:
1. File → Packages → Resolve Package Versions
2. Clean build folder: Cmd + Shift + K
3. Rebuild: Cmd + B

### Authentication Failures

**Problem**: Login returns 401

**Solution**:
1. Verify backend is running
2. Check API URL in `AppEnvironment.swift`
3. Inspect Network tab in backend logs

## 📚 Related Documentation

- [Main PageSpace Docs](../../docs/)
- [API Documentation](../../docs/1.0-overview/api-list.md)
- [iOS Restructure Guide](../../apps/IOS_RESTRUCTURE.md)

## 🎯 Next Steps

- [ ] Complete Socket.IO real-time integration
- [ ] Add push notifications
- [ ] Implement offline mode with local caching
- [ ] Add file upload support
- [ ] Implement page browsing and editing
- [ ] Add workspace/drive management

## 📝 Migration Notes

This app was migrated from a Swift Package Manager structure to a proper Xcode iOS app project on 2025-11-01. The original source code is archived at `mobile.archive/` in the repository root.

See [IOS_RESTRUCTURE.md](../../apps/IOS_RESTRUCTURE.md) for full migration details.
