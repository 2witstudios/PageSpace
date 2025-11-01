# PageSpace iOS App Restructure Guide

## Current Situation

The PageSpace iOS mobile app exists in two incomplete states:

### 1. Old Swift Package Structure (Source Code)
**Location**: `/Users/jono/Production/PageSpace/mobile/`

This contains ALL the actual application code:
- ✅ **Complete source code** with all features implemented
- ✅ **All dependencies resolved** via Swift Package Manager
- ✅ **All Swift files** (AuthManager, APIClient, Models, Views, Services)
- ✅ **Tests** written and passing
- ✅ **Builds successfully** with zero warnings
- ❌ **Cannot run as an iOS app** - configured as a library in `Package.swift`

**Structure**:
```
mobile/
├── Package.swift                    # SPM package definition (library product)
├── Package.resolved                 # Locked dependency versions
├── PageSpaceMobile/
│   ├── App/
│   │   ├── PageSpaceMobileApp.swift  # @main entry point
│   │   └── Configuration/
│   │       └── Environment.swift     # API URLs (renamed to AppEnvironment)
│   ├── Core/
│   │   ├── Networking/
│   │   │   ├── APIClient.swift       # HTTP + SSE client
│   │   │   ├── APIEndpoints.swift    # Endpoint definitions
│   │   │   └── AuthManager.swift     # JWT authentication
│   │   ├── Models/
│   │   │   ├── Message.swift         # Message + MessagePart models
│   │   │   ├── Conversation.swift    # Conversation models
│   │   │   ├── User.swift            # User + auth models
│   │   │   └── Page.swift            # Page, Drive, Agent models
│   │   └── Services/
│   │       ├── AIService.swift       # AI chat operations
│   │       ├── AgentService.swift    # Agent management
│   │       ├── ConversationService.swift
│   │       ├── PageAIService.swift
│   │       └── RealtimeService.swift # Socket.IO (placeholder)
│   ├── Features/
│   │   ├── Auth/
│   │   │   ├── LoginView.swift
│   │   │   └── LoginViewModel.swift
│   │   ├── Agents/
│   │   │   ├── AgentListView.swift
│   │   │   └── AgentPickerView.swift
│   │   ├── Conversations/
│   │   │   ├── ConversationListView.swift
│   │   │   └── ConversationListViewModel.swift
│   │   ├── Chat/
│   │   │   ├── ChatView.swift
│   │   │   ├── ChatViewModel.swift
│   │   │   ├── UnifiedChatView.swift
│   │   │   ├── UnifiedChatViewModel.swift
│   │   │   ├── MessageRow.swift
│   │   │   └── QuickChatView.swift
│   │   └── Settings/
│   │       └── SettingsView.swift
│   └── Resources/
│       └── Info.plist
└── PageSpaceMobileTests/
    └── PageSpaceMobileTests.swift
```

**Dependencies** (from Package.swift):
- `socket.io-client-swift` (v16.1.1) - Real-time Socket.IO
- `swift-markdown-ui` (v2.4.1) - Markdown rendering
- `swift-async-algorithms` (v1.0.4) - Stream processing

### 2. New Xcode iOS App Project (Empty Shell)
**Location**: `/Users/jono/Production/PageSpace/apps/ios/PageSpace/`

This is a proper iOS App project structure:
- ✅ **Correct Xcode project** (`PageSpace.xcodeproj`)
- ✅ **Runnable on simulator/device**
- ❌ **Only has boilerplate code** (empty ContentView)
- ❌ **No dependencies added yet**
- ❌ **Missing all PageSpace functionality**

**Structure**:
```
apps/ios/
├── PageSpace.xcodeproj/             # Xcode project file
├── PageSpace/
│   ├── PageSpaceApp.swift           # Empty @main entry point
│   ├── ContentView.swift            # Boilerplate view
│   └── Assets.xcassets              # Empty asset catalog
├── PageSpaceTests/
└── PageSpaceUITests/
```

## The Problem

**Swift Package Manager Limitation**: SPM's `.library()` product type compiles to a `.o` object file and `.swiftmodule`, not an executable iOS app (`.app` bundle). iOS apps require:
- An `Info.plist` with bundle configuration
- An `.app` bundle structure with resources
- Code signing and provisioning profiles
- Entry point marked with `@UIApplicationMain` or `@main`

The old structure builds successfully but produces `PageSpaceMobile.o` instead of an installable app.

## The Solution: Migration Plan

We need to **copy all source code** from the Swift Package into the Xcode iOS App project.

### Step 1: Add Dependencies to Xcode Project

Open `apps/ios/PageSpace/PageSpace.xcodeproj` in Xcode:

1. **File → Add Package Dependencies**
2. Add each dependency:
   - `https://github.com/socketio/socket.io-client-swift` (v16.1.1)
   - `https://github.com/gonzalezreal/swift-markdown-ui` (v2.4.1)
   - `https://github.com/apple/swift-async-algorithms` (v1.0.4)

### Step 2: Migrate Directory Structure

Copy the entire `PageSpaceMobile/` source structure into the Xcode project:

```bash
# From: /Users/jono/Production/PageSpace/mobile/PageSpaceMobile/
# To:   /Users/jono/Production/PageSpace/apps/ios/PageSpace/PageSpace/

# Copy structure:
apps/ios/PageSpace/PageSpace/
├── App/
│   ├── PageSpaceApp.swift           # Replace boilerplate with PageSpaceMobileApp.swift
│   └── Configuration/
│       └── AppEnvironment.swift     # Renamed from Environment.swift
├── Core/
│   ├── Networking/
│   ├── Models/
│   └── Services/
├── Features/
│   ├── Auth/
│   ├── Agents/
│   ├── Conversations/
│   ├── Chat/
│   └── Settings/
└── Resources/
    ├── Assets.xcassets              # Merge with existing
    └── Info.plist                   # Configure properly
```

### Step 3: Update Xcode Project References

After copying files physically:

1. **In Xcode**, right-click on `PageSpace` group
2. **Add Files to "PageSpace"...**
3. Select all copied directories (App, Core, Features)
4. ✅ Check "Copy items if needed" (already copied, so this is optional)
5. ✅ Check "Create groups"
6. ✅ Add to target: "PageSpace"

### Step 4: Configure Info.plist

Update `/apps/ios/PageSpace/PageSpace/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>PageSpace</string>
    <key>CFBundleIdentifier</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>LSRequiresIPhoneOS</key>
    <true/>
    <key>UIRequiredDeviceCapabilities</key>
    <array>
        <string>arm64</string>
    </array>
    <key>UISupportedInterfaceOrientations</key>
    <array>
        <string>UIInterfaceOrientationPortrait</string>
        <string>UIInterfaceOrientationLandscapeLeft</string>
        <string>UIInterfaceOrientationLandscapeRight</string>
    </array>
    <key>UILaunchStoryboardName</key>
    <string>LaunchScreen</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsArbitraryLoads</key>
        <true/>
    </dict>
</dict>
</plist>
```

**Key Setting**: `NSAllowsArbitraryLoads` allows HTTP connections to localhost:3000 for development.

### Step 5: Replace Entry Point

Replace `apps/ios/PageSpace/PageSpace/PageSpaceApp.swift` with content from `mobile/PageSpaceMobile/App/PageSpaceMobileApp.swift`:

```swift
import SwiftUI

@main
struct PageSpaceApp: App {
    @StateObject private var authManager = AuthManager.shared
    @StateObject private var realtimeService = RealtimeService.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(authManager)
                .environmentObject(realtimeService)
                .onAppear {
                    if authManager.isAuthenticated {
                        realtimeService.connect()
                    }
                }
                .onChange(of: authManager.isAuthenticated) { oldValue, newValue in
                    if newValue {
                        realtimeService.connect()
                    } else {
                        realtimeService.disconnect()
                    }
                }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var authManager: AuthManager

    var body: some View {
        if authManager.isAuthenticated {
            MainTabView()
        } else {
            LoginView()
        }
    }
}

struct MainTabView: View {
    var body: some View {
        TabView {
            AgentListView()
                .tabItem {
                    Label("Agents", systemImage: "brain.head.profile")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
    }
}
```

### Step 6: Delete Old ContentView

Delete the boilerplate `ContentView.swift` from the Xcode project (it's now integrated into PageSpaceApp.swift).

### Step 7: Build & Run

1. **Select scheme**: PageSpace
2. **Select destination**: iPhone 16 (or any iOS 17+ simulator)
3. **Press Cmd + R**

The app should now build and run with all functionality!

## Post-Migration Cleanup

Once the Xcode project is working:

### Option 1: Archive Old Swift Package
```bash
cd /Users/jono/Production/PageSpace
mv mobile mobile.archive
# Keep as reference but remove from active use
```

### Option 2: Delete Old Swift Package
```bash
cd /Users/jono/Production/PageSpace
rm -rf mobile
# Only if confirmed working in new location
```

### Update Documentation

- Update main `apps/ios/README.md` to reflect new structure
- Update root `README.md` to reference `apps/ios` instead of `mobile`
- Keep migration notes in this file for reference

## Why This Structure?

### Monorepo Consistency
```
PageSpace/
├── apps/
│   ├── web/        # Next.js web app
│   ├── realtime/   # Socket.IO service
│   ├── processor/  # File processing
│   ├── desktop/    # Electron desktop app
│   └── ios/        # iOS native app ← New!
└── packages/
    ├── db/         # Database schema (could share types)
    └── lib/        # Shared utilities
```

All applications live in `apps/`, making the architecture clear and consistent.

### Future Code Sharing Potential

While currently independent, the iOS app could eventually share:
- **TypeScript → Swift Type Generation**: Auto-generate Swift models from TypeScript types
- **API Endpoint Definitions**: Single source of truth for routes
- **Constants**: API versions, feature flags, etc.

## Technical Details

### Dependencies Resolved
All Swift concurrency warnings fixed:
- ✅ AuthManager now properly isolated
- ✅ All `onChange` updated to iOS 17 syntax
- ✅ Message models properly decodable
- ✅ Zero warnings in build

### Backend Configuration
Currently points to:
- API: `http://localhost:3000`
- Realtime: `http://localhost:3001`

Located in: `AppEnvironment.swift` (renamed from `Environment.swift` to avoid SwiftUI conflict)

### Authentication Flow
- JWT-based auth with Keychain storage
- CSRF token handling for write operations
- Session management with auto-reconnect

### AI Features
- Global AI Assistant (personal chat)
- Page AI Agents (specialized agents per workspace)
- Agent switching with context preservation
- Streaming responses with Server-Sent Events (SSE)
- Tool calling visualization

## Files That Must Be Updated

After migration, update import paths or references in:

1. **Tests**: `PageSpaceMobileTests/` → Update module imports
2. **Documentation**: Update file paths in README.md, SETUP.md, QUICK_START.md
3. **.gitignore**: Add Xcode-specific ignores if not present

## Success Criteria

Migration is complete when:

- ✅ Xcode project builds without errors
- ✅ App runs on iOS simulator
- ✅ Login screen appears
- ✅ Can authenticate with backend
- ✅ Agent list loads
- ✅ Can send/receive chat messages
- ✅ Real-time features work (when Socket.IO enabled)

## Current Status

- **Old Swift Package**: Complete, builds successfully, all code written and tested
- **New Xcode Project**: Shell created, awaiting code migration
- **Next Step**: Execute migration steps 1-7 above

---

**Document Created**: 2025-11-01
**Purpose**: Guide for migrating PageSpace Mobile from Swift Package to proper iOS App structure
**Context**: Swift Package Manager doesn't support iOS app products, requiring Xcode project for runnable app
