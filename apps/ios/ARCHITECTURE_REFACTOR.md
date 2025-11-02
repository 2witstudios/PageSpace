# iOS Architecture Refactor: Match Web App Conversation System

## Executive Summary

**Problem**: iOS currently over-engineers conversation/agent management by creating `Agent` objects from `Conversation` data, leading to confusion between agent names and conversation titles.

**Solution**: Simplify iOS architecture to match the web app's proven pattern - work directly with `Conversation` objects and derive agent information from context (AgentsList selection) or message metadata (`agentRole` field).

---

## Current Architecture Issues

### What iOS Does Wrong

```swift
// ❌ WRONG: Creating Agent from Conversation
let agent = Agent(
    id: "global_default",
    type: .global,
    title: conversation.title,  // BUG: This is conversation title, not agent name!
    conversationId: conversation.id
)
```

**Problems:**
1. Conflates agent identity with conversation title
2. Loses agent context when loading from Recents
3. Forces awkward mapping between Conversation and Agent models
4. Doesn't match web app architecture
5. Makes "+" button confused about which agent to use

### What Web App Does Right

```typescript
// ✅ CORRECT: Work with Conversation directly
interface Conversation {
  id: string;
  title: string | null;
  type: 'global' | 'page' | 'drive';
  contextId: string | null;  // pageId or driveId
  lastMessageAt: Date | null;
}

// Display: conversation.title
// Agent info: derived from context or message.agentRole
```

**Benefits:**
1. Simple, single source of truth
2. Agent information comes from selection context or messages
3. No artificial Agent↔Conversation mapping
4. Matches backend data model exactly

---

## Target Architecture (Option 2)

### Core Principle

**"Agent is the thing you SELECT to chat with. Conversation is the chat history."**

- `Agent` model: Used ONLY in AgentsList for selection (Global Assistant, Page AI agents)
- `Conversation` model: Used everywhere else (ChatView, Recents, history)
- Agent information flows from selection → conversation creation, not the reverse

### Data Flow

```
1. USER STARTS NEW CHAT
   AgentsList → User selects "Global Assistant"
   ↓
   AgentService.selectedAgent = Agent(id: "global", type: .global)
   ↓
   HomeView → ChatView with selectedAgent
   ↓
   ChatView: conversationId = nil → fresh conversation
   ↓
   User sends message → creates Conversation(type: "global", contextId: nil)

2. USER CLICKS RECENT CONVERSATION
   Recents → User taps Conversation(id: "abc123", title: "List my drives", type: "global")
   ↓
   HomeView → ChatView with conversation
   ↓
   ChatView: loads Conversation directly, NO Agent reconstruction
   ↓
   Display: conversation.title in toolbar
```

---

## File-by-File Changes

### 1. **Models/Agent.swift** (KEEP, but clarify purpose)

**Purpose**: Only for AgentsList selection, NOT for loaded conversations

```swift
/// Represents an agent TYPE that the user can select to start a chat
/// NOT used for displaying loaded conversations
/// Agent info for loaded conversations comes from Conversation.type/contextId
struct Agent: Identifiable, Codable, Equatable {
    let id: String          // "global" or pageId
    let type: AgentType     // .global or .pageAI
    let title: String       // Display name: "Global Assistant" or page name
    let subtitle: String?   // Description
    let icon: String        // SF Symbol name
    let pageId: String?     // For .pageAI type

    // ❌ REMOVE: conversationId field
    // Conversations are loaded separately, not stored in Agent
}
```

### 2. **Models/Conversation.swift** (NEW or UPDATE)

**Purpose**: Direct mapping to API response, used for history and display

```swift
struct Conversation: Identifiable, Codable, Equatable {
    let id: String
    let title: String?
    let type: String        // "global" | "page" | "drive"
    let contextId: String?  // pageId for page, driveId for drive, nil for global
    let lastMessageAt: Date?
    let createdAt: Date

    // Computed properties for display
    var displayTitle: String {
        title ?? "New Conversation"
    }

    var isGlobal: Bool { type == "global" }
    var isPageAI: Bool { type == "page" }
    var isDriveAI: Bool { type == "drive" }
}
```

### 3. **ConversationManager.swift** (MAJOR REFACTOR)

**Current state tracking:**
```swift
@Published var currentConversationId: String?
@Published var messages: [Message] = []
@Published var streamingMessage: Message?
```

**Add:**
```swift
// Track the AGENT user selected (for creating new conversations)
// This is set by AgentService when user picks an agent
@Published var selectedAgentType: String? = nil  // "global", pageId, or driveId
@Published var selectedAgentContextId: String? = nil  // nil for global, pageId/driveId otherwise

// Track the loaded conversation (for display)
@Published var currentConversation: Conversation? = nil
```

**Updated methods:**

```swift
/// Load a specific conversation (from Recents)
func loadConversation(_ conversation: Conversation) async {
    guard conversation.id != currentConversationId else { return }

    isLoadingConversation = true
    messages = []
    currentConversation = conversation
    currentConversationId = conversation.id

    do {
        let response = try await aiService.loadMessages(conversationId: conversation.id)
        messages = response.messages

        // Update selected agent to match loaded conversation
        selectedAgentType = conversation.type
        selectedAgentContextId = conversation.contextId

        print("✅ Loaded conversation: \(conversation.displayTitle)")
    } catch {
        self.error = "Failed to load conversation: \(error.localizedDescription)"
    }

    isLoadingConversation = false
}

/// Start a new conversation with the currently selected agent
func createNewConversation() {
    print("🆕 Creating new conversation with agent: \(selectedAgentType ?? "unknown")")
    currentConversationId = nil
    currentConversation = nil
    messages = []
    streamingMessage = nil
    streamingMessageBuilder = nil
    streamThrottle.cancel()
    error = nil
}

/// Send message - auto-creates conversation if needed
func sendMessage(_ text: String) async {
    // ... existing code ...

    // When creating new conversation, use selected agent info
    if conversationId == nil {
        let type = selectedAgentType ?? "global"
        let contextId = selectedAgentContextId

        let newConversation = try await conversationService.createConversation(
            title: nil,  // Auto-generated
            type: type,
            contextId: contextId
        )
        conversationId = newConversation.id
        currentConversationId = conversationId
        currentConversation = newConversation
    }

    // ... rest of existing code ...
}
```

### 4. **AgentService.swift** (UPDATE)

**Purpose**: Track which agent user selected for NEW conversations

```swift
@MainActor
class AgentService: ObservableObject {
    static let shared = AgentService()

    @Published var selectedAgent: Agent?

    private let conversationManager = ConversationManager.shared

    func selectAgent(_ agent: Agent) {
        print("🎯 Selected agent: \(agent.title)")
        self.selectedAgent = agent

        // Update ConversationManager's selected agent info
        conversationManager.selectedAgentType = agent.type == .global ? "global" : "page"
        conversationManager.selectedAgentContextId = agent.pageId

        // Create fresh conversation
        conversationManager.createNewConversation()
    }
}
```

### 5. **ChatView.swift** (MAJOR REFACTOR)

**Change from**: Receiving `agent: Agent`
**Change to**: Display based on ConversationManager state

```swift
struct ChatView: View {
    @Binding var isSidebarOpen: Bool
    @EnvironmentObject var conversationManager: ConversationManager
    @EnvironmentObject var agentService: AgentService
    @State private var messageText = ""

    var body: some View {
        VStack(spacing: 0) {
            // Messages list (unchanged)
            // ...

            // Input area (unchanged)
            // ...
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: { isSidebarOpen.toggle() }) {
                    Image(systemName: "line.3.horizontal")
                }
            }

            ToolbarItem(placement: .principal) {
                // Display conversation title if exists, else agent name
                Button(action: { isSidebarOpen.toggle() }) {
                    VStack(spacing: 2) {
                        if let conversation = conversationManager.currentConversation {
                            // Show conversation title
                            Text(conversation.displayTitle)
                                .font(.headline)
                            // Optionally show agent type in small text
                            Text(agentTypeLabel(conversation.type))
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        } else if let agent = agentService.selectedAgent {
                            // New conversation - show agent name
                            Text(agent.title)
                                .font(.headline)
                            if let subtitle = agent.subtitle {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        } else {
                            // Fallback
                            Text("Chat")
                                .font(.headline)
                        }
                    }
                }
            }

            ToolbarItem(placement: .navigationBarTrailing) {
                Button(action: {
                    conversationManager.createNewConversation()
                }) {
                    Image(systemName: "plus")
                }
            }
        }
        .task {
            // NO LOGIC HERE
            // Conversation loading is handled by ConversationList
            // Agent selection is handled by AgentsList
            // This view just displays whatever ConversationManager has
        }
    }

    private func agentTypeLabel(_ type: String) -> String {
        switch type {
        case "global": return "Global Assistant"
        case "page": return "Page AI"
        case "drive": return "Drive AI"
        default: return ""
        }
    }
}
```

### 6. **HomeView.swift** (SIMPLIFY)

**Change from**: Passing `agent` to ChatView
**Change to**: ChatView uses ConversationManager/AgentService directly

```swift
struct HomeView: View {
    @StateObject private var conversationManager = ConversationManager.shared
    @StateObject private var agentService = AgentService.shared
    @State private var isSidebarOpen = false

    var body: some View {
        NavigationStack {
            ChatView(isSidebarOpen: $isSidebarOpen)
                .environmentObject(conversationManager)
                .environmentObject(agentService)
        }
        .overlay(alignment: .leading) {
            if isSidebarOpen {
                SidebarView(isOpen: $isSidebarOpen)
                    .environmentObject(conversationManager)
                    .environmentObject(agentService)
                    .transition(.move(edge: .leading))
            }
        }
    }
}
```

### 7. **ConversationList.swift** (SIMPLIFY)

**Change from**: Creating fake Agent objects
**Change to**: Load Conversation directly

```swift
private func selectConversation(_ conversation: Conversation) async {
    print("🟣 Loading conversation: \(conversation.displayTitle)")

    // Simply load the conversation
    await conversationManager.loadConversation(conversation)

    // Close sidebar
    isOpen = false
}
```

### 8. **AgentsList.swift** (SIMPLIFY)

**Keep current behavior**: Select agent → create fresh conversation

```swift
private func selectAgent(_ agent: Agent) {
    print("🎯 Selected agent: \(agent.title)")

    // This sets selectedAgent and creates fresh conversation
    agentService.selectAgent(agent)

    // Close sidebar/dismiss view
    dismiss()
}
```

---

## Data Flow Examples

### Example 1: User Starts Fresh Global Chat

```
1. User taps "Global Assistant" in AgentsList
   ↓
2. AgentService.selectAgent(Agent(type: .global))
   ↓
3. ConversationManager.selectedAgentType = "global"
   ConversationManager.selectedAgentContextId = nil
   ConversationManager.createNewConversation()
   ↓
4. ChatView displays: "Global Assistant" (from agentService.selectedAgent)
   ↓
5. User types "List my drives" and sends
   ↓
6. ConversationManager.sendMessage():
   - Creates Conversation(type: "global", contextId: nil)
   - Title auto-generated as "List my drives"
   - currentConversation = newConversation
   ↓
7. ChatView displays: "List my drives" (from conversationManager.currentConversation)
```

### Example 2: User Clicks Recent Conversation

```
1. User taps conversation in Recents
   Conversation(id: "abc", title: "List my drives", type: "global")
   ↓
2. ConversationList.selectConversation()
   ↓
3. ConversationManager.loadConversation(conversation)
   - Loads messages
   - Sets currentConversation
   - Updates selectedAgentType to match conversation
   ↓
4. ChatView displays: "List my drives" (from conversationManager.currentConversation)
   ↓
5. User clicks "+" button
   ↓
6. ConversationManager.createNewConversation()
   - Keeps selectedAgentType = "global" (from loaded conversation)
   - Clears currentConversation and messages
   ↓
7. ChatView displays: "Global Assistant" (from agentService.selectedAgent)
   User can start new conversation with same agent
```

### Example 3: User Switches from Global to Page AI

```
1. Currently in conversation: "List my drives" (global)
   ↓
2. User opens AgentsList, selects "Project Notes" (page AI)
   ↓
3. AgentService.selectAgent(Agent(type: .pageAI, pageId: "page123"))
   ↓
4. ConversationManager.createNewConversation()
   - selectedAgentType = "page"
   - selectedAgentContextId = "page123"
   - Clears old conversation
   ↓
5. ChatView displays: "Project Notes" (from agentService.selectedAgent)
   ↓
6. User sends message
   ↓
7. Creates Conversation(type: "page", contextId: "page123")
```

---

## Migration Strategy

### Phase 1: Update Models (Low Risk)

1. Add `Conversation` model matching API
2. Update `Agent` model (remove `conversationId`)
3. Add `selectedAgentType` and `selectedAgentContextId` to ConversationManager

### Phase 2: Update ConversationManager (Medium Risk)

1. Add `currentConversation: Conversation?` property
2. Update `loadConversation()` to accept `Conversation` parameter
3. Update `sendMessage()` to create conversation with selected agent info

### Phase 3: Update UI Components (Medium Risk)

1. Refactor `ChatView` to use ConversationManager state directly (no agent parameter)
2. Update `HomeView` to remove agent passing
3. Simplify `ConversationList` to load conversations directly

### Phase 4: Update Selection (Low Risk)

1. Update `AgentService.selectAgent()` to set ConversationManager agent info
2. Verify AgentsList still works correctly

### Phase 5: Testing (High Importance)

1. Test: Select Global Assistant → send message → verify conversation created
2. Test: Click recent conversation → verify it loads correctly
3. Test: Click "+" → verify new conversation with same agent
4. Test: Switch agents → verify old conversation cleared
5. Test: Select Page AI agent → send message → verify page AI conversation created
6. Test: Load page AI conversation from recents → verify correct agent info

---

## Benefits of This Architecture

### 1. **Simplicity**
- No artificial Agent↔Conversation mapping
- Single source of truth (ConversationManager)
- Clear separation: Agent = selection, Conversation = history

### 2. **Matches Web App**
- Same data model (Conversation with type/contextId)
- Same flow (select agent → create conversation)
- Easy to add features from web (agent roles, etc.)

### 3. **Maintainability**
- Less code, fewer abstractions
- Clear data flow
- Easier to debug

### 4. **Extensibility**
- Easy to add message-level `agentRole` (matches web)
- Easy to add drive AI conversations
- Easy to implement "continue in different agent" feature

### 5. **Correctness**
- Agent type always correct (from selection or loaded conversation)
- Conversation title always correct (from API)
- "+" button always knows which agent (from ConversationManager state)

---

## Future Enhancements (After Refactor)

### 1. Message-Level Agent Roles

Match web app's per-message `agentRole`:

```swift
struct Message: Codable {
    let id: String
    let role: MessageRole
    let parts: [MessagePart]
    let agentRole: String  // "PARTNER" | "CODER" | "PRODUCTIVITY" | etc.
    let createdAt: Date
}
```

### 2. Continue Conversation in Different Agent

```swift
func continueInAgent(_ agent: Agent) {
    // Copy messages to new conversation with different agent
    selectedAgentType = agent.type == .global ? "global" : "page"
    selectedAgentContextId = agent.pageId
    // Keep messages but create new conversation
}
```

### 3. Lazy Load Page Names for Page AI Conversations

```swift
func fetchPageName(for conversation: Conversation) async throws -> String? {
    guard conversation.isPageAI, let pageId = conversation.contextId else {
        return nil
    }
    let page = try await pageService.getPage(id: pageId)
    return page.name
}
```

---

## Success Criteria

✅ User can select agent from AgentsList → creates fresh conversation
✅ User can click recent conversation → loads correctly with proper title
✅ User can click "+" → creates new conversation with current agent
✅ Switching agents clears previous conversation
✅ Toolbar displays correct information (conversation title or agent name)
✅ No confusion between agent names and conversation titles
✅ Architecture matches web app patterns
✅ Code is simpler and more maintainable than before

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing functionality | High | Thorough testing, gradual rollout |
| Data model mismatch with API | High | Match web app's Conversation type exactly |
| State management complexity | Medium | Use ConversationManager as single source of truth |
| UI flickering during refactor | Low | Test thoroughly, use proper SwiftUI patterns |

---

## Timeline Estimate

- **Phase 1 (Models)**: 1 hour
- **Phase 2 (ConversationManager)**: 2 hours
- **Phase 3 (UI Components)**: 3 hours
- **Phase 4 (Selection)**: 1 hour
- **Phase 5 (Testing)**: 2 hours

**Total**: ~9 hours for complete refactor

---

## Conclusion

This refactor simplifies the iOS app architecture to match the web app's proven design. By removing the artificial Agent↔Conversation mapping and working directly with Conversation objects, we eliminate the confusion between agent names and conversation titles while making the codebase more maintainable and extensible.

The key insight: **Agent is what you SELECT. Conversation is what you LOAD.**
