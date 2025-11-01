# PageSpace Mobile - Setup Guide

Complete guide to set up the PageSpace Swift iOS companion app for development.

---

## Prerequisites

### 1. Development Environment

- **macOS**: 13.0 (Ventura) or later
- **Xcode**: 15.0 or later
- **iOS Target**: iOS 17.0+
- **Swift**: 5.9+

### 2. PageSpace Backend

The mobile app requires a running PageSpace backend:

```bash
# In the main PageSpace directory
pnpm install
pnpm dev  # Starts web (port 3000), realtime (3001), processor (3003)
```

Ensure these services are running:
- ✅ Web app: `http://localhost:3000`
- ✅ Realtime: `http://localhost:3001`
- ✅ Processor: `http://localhost:3003`

---

## Quick Start

### 1. Clone Repository

```bash
cd PageSpace
ls mobile/  # This directory
```

### 2. Install Dependencies

The project uses **Swift Package Manager** (SPM). Dependencies will auto-install when you open the project in Xcode.

**Dependencies**:
- `socket.io-client-swift` (v16.0.0) - Real-time Socket.IO
- `swift-markdown-ui` (v2.0.0) - Markdown rendering
- `swift-async-algorithms` (v1.0.0) - Stream processing

### 3. Open Project in Xcode

```bash
cd mobile
open Package.swift  # Opens in Xcode
```

Or use Xcode:
1. Open Xcode
2. File → Open
3. Navigate to `PageSpace/mobile/`
4. Select `Package.swift`

### 4. Configure Backend URL

Edit `PageSpaceMobile/App/Configuration/Environment.swift`:

```swift
static let apiBaseURL: URL = {
    #if DEBUG
    return URL(string: "http://localhost:3000")!  // ← Your local backend
    #else
    return URL(string: "https://your-domain.com")!  // ← Production URL
    #endif
}()
```

For **physical device testing**, use your Mac's local IP:

```swift
return URL(string: "http://192.168.1.100:3000")!  // Replace with your Mac IP
```

Find your Mac IP:
```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
```

### 5. Build & Run

1. Select target device (simulator or physical device)
2. Press `Cmd + R` to build and run
3. Wait for dependencies to resolve (first time only)

---

## Project Structure

```
mobile/
├── Package.swift                    # SPM dependencies
├── PageSpaceMobile/
│   ├── App/
│   │   ├── PageSpaceMobileApp.swift     # App entry point
│   │   └── Configuration/
│   │       └── Environment.swift        # Backend URLs
│   ├── Core/
│   │   ├── Networking/
│   │   │   ├── APIClient.swift          # HTTP + SSE client
│   │   │   ├── APIEndpoints.swift       # Endpoint definitions
│   │   │   └── AuthManager.swift        # JWT authentication
│   │   ├── Models/
│   │   │   ├── Message.swift            # Message + MessagePart
│   │   │   ├── Conversation.swift       # Conversation models
│   │   │   └── User.swift               # User + auth models
│   │   └── Services/
│   │       ├── AIService.swift          # AI chat operations
│   │       ├── ConversationService.swift
│   │       └── RealtimeService.swift    # Socket.IO (placeholder)
│   ├── Features/
│   │   ├── Auth/
│   │   │   ├── LoginView.swift
│   │   │   └── LoginViewModel.swift
│   │   ├── Conversations/
│   │   │   ├── ConversationListView.swift
│   │   │   └── ConversationListViewModel.swift
│   │   └── Chat/
│   │       ├── ChatView.swift           # Main chat interface
│   │       ├── ChatViewModel.swift
│   │       ├── MessageRow.swift         # Message rendering
│   │       └── MessagePartView.swift    # Text + tool rendering
│   ├── Shared/
│   │   └── Components/                  # Reusable UI components
│   └── Resources/
│       ├── Assets.xcassets
│       └── Info.plist
├── PageSpaceMobileTests/               # Unit tests
└── docs/
    ├── API_CONTRACT.md                 # API documentation
    └── AUTHENTICATION_FLOW.md          # Auth documentation
```

---

## Testing

### Run Tests

```bash
# Command line
swift test

# Or in Xcode
Cmd + U
```

### Test Coverage Areas

- ✅ Authentication flow
- ✅ Message parsing
- ✅ SSE stream handling
- ✅ API client error handling
- ⬜ UI tests (future)

---

## Configuration

### 1. Bundle Identifier

Edit in Xcode:
1. Select project in navigator
2. Select "PageSpaceMobile" target
3. General → Identity → Bundle Identifier
4. Change to your team's identifier (e.g., `com.yourcompany.pagespace`)

### 2. Signing

1. Select target → Signing & Capabilities
2. Enable "Automatically manage signing"
3. Select your team
4. Xcode will provision certificates automatically

### 3. Environment Variables

Create `PageSpaceMobile/App/Configuration/Secrets.swift` (gitignored):

```swift
enum Secrets {
    static let apiKey = "your-api-key-here"
    // Add other secrets as needed
}
```

---

## Running on Physical Device

### 1. Trust Developer Certificate

First time running on device:
1. Run app from Xcode (may fail first time)
2. On device: Settings → General → VPN & Device Management
3. Trust your developer certificate

### 2. Network Configuration

**Option A: Use Mac IP** (recommended)
```swift
// Environment.swift
return URL(string: "http://192.168.1.100:3000")!
```

**Option B: Use ngrok** (for external access)
```bash
# Terminal
ngrok http 3000

# Use ngrok URL in Environment.swift
return URL(string: "https://abc123.ngrok.io")!
```

---

## Troubleshooting

### Issue: "Cannot connect to backend"

**Check**:
1. ✅ Backend is running: `curl http://localhost:3000/api/auth/login`
2. ✅ Correct URL in `Environment.swift`
3. ✅ Firewall allows connections (Mac System Preferences → Security)
4. ✅ On device: Using Mac IP, not `localhost`

### Issue: "Build failed - package resolution"

**Solution**:
1. File → Packages → Reset Package Caches
2. File → Packages → Resolve Package Versions
3. Clean build folder: `Cmd + Shift + K`
4. Rebuild: `Cmd + B`

### Issue: "Keychain access denied"

**Solution**:
1. Simulator → Device → Erase All Content and Settings
2. Rebuild and run

### Issue: "SSE stream disconnects immediately"

**Check**:
1. ✅ Backend logs for errors
2. ✅ JWT token is valid
3. ✅ CSRF token is included (for POST requests)
4. ✅ Network timeout is sufficient (5 min)

### Issue: "Socket.IO not connecting"

**Note**: Socket.IO integration is currently a placeholder. To enable:

1. Uncomment SocketIO import in `RealtimeService.swift`
2. Uncomment Socket.IO client code
3. Ensure realtime service is running on port 3001

---

## Development Workflow

### 1. Feature Development

```bash
# Create feature branch
git checkout -b feature/mobile-push-notifications

# Make changes in Xcode
# ...

# Test
Cmd + U

# Commit
git add .
git commit -m "feat: Add push notifications for new messages"

# Push
git push origin feature/mobile-push-notifications
```

### 2. Testing Backend Changes

When backend API changes:
1. Update `APIEndpoints.swift` if needed
2. Update models in `Core/Models/`
3. Update corresponding services
4. Run tests to verify

### 3. UI Iteration

Use SwiftUI Previews for fast iteration:

```swift
#Preview {
    ChatView(conversationId: "preview-id")
        .environmentObject(AuthManager.shared)
}
```

Press `Cmd + Opt + P` to refresh preview.

---

## Next Steps

### MVP Phase 1 ✅
- [x] Authentication (login/logout)
- [x] Conversation list
- [x] Chat view with streaming
- [x] Message rendering (text + tools)
- [ ] **Deploy to TestFlight**

### Phase 2 (Future)
- [ ] Offline mode with local caching
- [ ] Real-time sync with Socket.IO
- [ ] Push notifications
- [ ] AI provider/model selection UI
- [ ] Search conversations

### Phase 3 (Future)
- [ ] Page AI integration
- [ ] Voice input with Whisper
- [ ] Image uploads for vision models
- [ ] Widgets and app shortcuts

---

## Deployment

### TestFlight Distribution

```bash
# 1. Archive for release
Xcode → Product → Archive

# 2. Validate archive
Window → Organizer → Validate App

# 3. Distribute to TestFlight
Organizer → Distribute App → TestFlight

# 4. Add testers in App Store Connect
https://appstoreconnect.apple.com
```

### App Store Submission

See [Apple's App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

Key requirements:
- Privacy policy (for AI data processing)
- App Store screenshots
- App description and keywords
- Age rating

---

## Resources

### Documentation
- [API Contract](docs/API_CONTRACT.md) - API endpoints and request/response formats
- [Authentication Flow](docs/AUTHENTICATION_FLOW.md) - JWT auth implementation
- [Main README](README.md) - Architecture overview

### External Resources
- [Swift Documentation](https://swift.org/documentation/)
- [SwiftUI Tutorials](https://developer.apple.com/tutorials/swiftui)
- [Vercel AI SDK](https://sdk.vercel.ai/docs) - Backend AI framework

---

## Support

For issues or questions:
1. Check [Troubleshooting](#troubleshooting) section
2. Review documentation in `/docs`
3. Check PageSpace main repo issues
4. Contact development team

---

## License

Same as PageSpace main project.
