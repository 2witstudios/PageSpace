# PageSpace Mobile - Agents Guide

## Overview

PageSpace Mobile uses an **agent-based architecture** that allows you to chat with different AI assistants, each with their own context and capabilities.

---

## Agent Types

### 1. **Global AI Assistant** (Default)

Your personal AI assistant that has access to your entire workspace.

**Characteristics**:
- Icon: Brain with head profile
- Access: All drives and pages
- Use case: General-purpose assistant
- Always available
- **Default agent** when you open the app

**Backend**: `/api/ai_conversations/global`

---

### 2. **Page AI Agents** (CHAT_AI Pages)

Specialized AI assistants embedded in specific pages. Each Page AI has:

**Characteristics**:
- Icon: Bubble with text
- Context: Scoped to a specific page and drive
- Custom configuration: System prompt, enabled tools, provider/model
- Use case: Topic-specific or role-specific assistants

**Examples**:
- Project planning assistant in "Project Notes" page
- Code review assistant in "Development" page
- Financial advisor in "Budget Analysis" page

**Backend**: `/api/ai/chat` (Page AI endpoints)

---

## UI Structure

### Navigation (Similar to Claude Projects)

```
┌─────────────────────────────────────────┐
│            Agents                       │
├─────────────────────────────────────────┤
│                                         │
│  Personal Assistant                     │
│  ├─ 🧠 Global Assistant          ✓     │
│                                         │
│  📁 My Workspace                        │
│  ├─ 💬 Project Planning                │
│  ├─ 💬 Code Review                     │
│                                         │
│  📁 Team Drive                          │
│  ├─ 💬 Marketing Strategy              │
│  └─ 💬 Customer Support                │
│                                         │
└─────────────────────────────────────────┘
```

### Tabs

**1. Agents Tab** (`AgentListView`)
- List of all available agents
- Grouped by: Personal Assistant + Drives
- Tap to open chat with that agent
- Current selection indicated with checkmark

**2. Settings Tab** (`SettingsView`)
- AI provider/model configuration
- Account settings
- Sign out

---

## Switching Agents

### From Agent List

1. Tap "Agents" tab
2. Browse available agents (grouped by drive)
3. Tap any agent to open chat

### Within Chat

1. While chatting, tap the agent icon (top-right)
2. Agent picker sheet opens
3. Select different agent
4. Chat switches context immediately

---

## How It Works

### Loading Agents

When you open the app, `AgentService` loads all agents:

1. **Fetch Global AI conversation**
   ```
   GET /api/ai_conversations/global
   → Returns global conversation
   → Creates Agent(type: .global)
   ```

2. **Fetch all drives**
   ```
   GET /api/drives
   → Returns list of drives user has access to
   ```

3. **For each drive, fetch AI_CHAT pages**
   ```
   GET /api/drives/{driveId}/pages
   → Filter pages where type == "AI_CHAT"
   → Create Agent(type: .pageAI) for each
   ```

4. **Display in UI**
   - Global agent appears first (default selected)
   - Page AI agents grouped by drive
   - Total count shown

---

## Sending Messages

### Global AI

```swift
// User sends message
POST /api/ai_conversations/global/messages

// Request body
{
  "messages": [...],
  "selectedProvider": "openrouter",
  "selectedModel": "anthropic/claude-3.5-sonnet",
  "locationContext": {
    "currentDrive": {...},
    "breadcrumbs": [...]
  },
  "agentRole": "PARTNER"
}

// Response: SSE stream
event: message
data: {"type":"text-delta","delta":{"text":"Hello"}}
```

---

### Page AI

```swift
// User sends message to specific page agent
POST /api/ai/chat

// Request body
{
  "messages": [...],
  "chatId": "page_123",  // pageId
  "conversationId": "conv_456",  // optional
  "pageContext": {
    "pageId": "page_123",
    "pageTitle": "Project Planning",
    "pageType": "AI_CHAT",
    "pagePath": "/workspace/projects/planning",
    "driveId": "drive_789",
    "driveName": "My Workspace"
  }
}

// Response: SSE stream (same format)
```

---

## Agent Configuration

### Page AI Custom Settings

Each Page AI can have custom configuration:

```swift
struct PageAIConfig {
    var systemPrompt: String?        // Custom instructions
    var enabledTools: [String]?      // Which tools this agent can use
    var aiProvider: String?          // Provider override
    var aiModel: String?             // Model override
}
```

**Example**:
```json
{
  "systemPrompt": "You are a project planning expert. Help users break down projects into actionable tasks.",
  "enabledTools": ["create_page", "update_page", "search_pages"],
  "aiProvider": "openrouter",
  "aiModel": "anthropic/claude-3-opus"
}
```

**Access**: GET/PATCH `/api/pages/{pageId}/agent-config`

---

## Data Flow

### Chat with Global AI

```
User types message in QuickChatView
     │
     ▼
UnifiedChatViewModel detects agent.type == .global
     │
     ▼
Calls AIService.sendMessage(conversationId: "global")
     │
     ▼
POST /api/ai_conversations/global/messages
     │
     ▼
Backend streams AI response (SSE)
     │
     ▼
UnifiedChatViewModel processes chunks
     │
     ▼
UI updates progressively as text arrives
```

### Chat with Page AI

```
User selects Page AI agent from list
     │
     ▼
UnifiedChatViewModel detects agent.type == .pageAI
     │
     ▼
Calls PageAIService.sendMessage(pageId: "page_123")
     │
     ▼
POST /api/ai/chat with pageContext
     │
     ▼
Backend loads page-specific config and context
     │
     ▼
Backend streams AI response (SSE)
     │
     ▼
UI updates progressively
```

---

## Agent Service Architecture

```swift
@MainActor
class AgentService: ObservableObject {
    @Published var agents: [Agent] = []
    @Published var selectedAgent: Agent?

    func loadAllAgents() async {
        // 1. Load global conversation
        // 2. Load all drives
        // 3. Load AI_CHAT pages from each drive
        // 4. Create Agent objects
        // 5. Set default to global
    }

    func selectAgent(_ agent: Agent) {
        selectedAgent = agent
    }
}
```

**State Management**:
- Singleton pattern (`AgentService.shared`)
- Published properties for reactive UI
- Automatic default selection (Global AI)
- Persists across app lifecycle

---

## UI Components

### AgentListView

Main navigation view showing all agents grouped by drive.

**Features**:
- Pull to refresh
- Section headers for drives
- Navigation to UnifiedChatView
- Current selection indicator

### AgentPickerView

Modal sheet for switching agents within a chat.

**Features**:
- Same grouping as AgentListView
- Tap to select and dismiss
- "Done" button to close without changing

### UnifiedChatView

Single chat view that works with any agent type.

**Features**:
- Agent-aware message loading
- Agent-aware message sending
- Toolbar shows agent icon
- Tap icon to open picker

### QuickChatView

Quick access to chat (defaults to Global AI).

**Use case**: Add as tab for instant access to default assistant.

---

## User Workflow

### Scenario 1: Quick Question (Global AI)

```
1. Open app
2. Global AI is already selected (default)
3. Type question and send
4. AI responds immediately
```

**No navigation required** - instant access to default assistant.

---

### Scenario 2: Topic-Specific Chat (Page AI)

```
1. Open app
2. Tap "Agents" tab
3. Browse drives
4. Find "📁 Projects → 💬 Project Planning"
5. Tap to open
6. Chat with specialized assistant
```

**Context**: AI has access to project-specific context and tools.

---

### Scenario 3: Switch Mid-Conversation

```
1. Chatting with Global AI
2. Realize you need specialized agent
3. Tap agent icon (top-right)
4. Select "Code Review" agent
5. Chat continues in new context
```

**Seamless switching** between different AI assistants.

---

## Benefits of Agent Architecture

### 1. **Organized Conversations**

Instead of a flat list of conversations, agents are grouped by workspace structure (drives).

### 2. **Context-Aware AI**

Page AI agents have deep context about their specific page/topic.

### 3. **Role-Based Assistants**

Create specialized agents for different roles (planner, reviewer, advisor).

### 4. **Easy Discovery**

All AI assistants visible in one place, grouped logically.

### 5. **Flexible Switching**

Switch between assistants without losing context.

---

## Future Enhancements

### Phase 2

- [ ] Agent search/filter
- [ ] Recent agents section
- [ ] Favorite/pin agents
- [ ] Agent icons/avatars from page metadata

### Phase 3

- [ ] Multi-agent workflows (one agent asks another)
- [ ] Agent collaboration (multiple agents in one chat)
- [ ] Agent templates (create new Page AI from template)
- [ ] Agent analytics (usage stats, token consumption)

---

## Comparison to Claude Projects

### Claude (Desktop)

```
Projects
├─ Personal Research
├─ Work Tasks
└─ Learning
```

### PageSpace Mobile

```
Agents
├─ Personal Assistant (Global AI)
└─ Drives
    ├─ My Workspace
    │   ├─ Project Planning (Page AI)
    │   └─ Code Review (Page AI)
    └─ Team Drive
        └─ Marketing Strategy (Page AI)
```

**Key Difference**: PageSpace agents are tied to workspace structure (drives/pages), while Claude Projects are standalone.

---

## Code Example

### Creating an Agent

```swift
// From Global AI Conversation
let globalAgent = Agent.fromGlobalConversation(conversation)
// {
//   id: "global_conv_123",
//   type: .global,
//   title: "Global Assistant",
//   icon: "brain.head.profile",
//   conversationId: "conv_123"
// }

// From Page AI
let pageAgent = Agent.fromPage(page, drive: drive)
// {
//   id: "page_page_456",
//   type: .pageAI,
//   title: "Project Planning",
//   subtitle: "My Workspace • /projects/planning",
//   icon: "bubble.left.and.text.bubble.right",
//   driveId: "drive_789",
//   pageId: "page_456",
//   aiConfig: {...}
// }
```

### Sending a Message

```swift
let viewModel = UnifiedChatViewModel(agent: selectedAgent)
await viewModel.sendMessage("What should I work on today?")

// Internally routes to correct service based on agent.type
// - Global AI → AIService
// - Page AI → PageAIService
```

---

## Conclusion

The agent-based architecture provides:

✅ **Unified interface** for all AI assistants
✅ **Logical grouping** by workspace structure
✅ **Easy switching** between contexts
✅ **Specialized assistants** with custom configurations
✅ **Default to Global AI** for instant access

This design mirrors the familiar "Projects" pattern from Claude while integrating seamlessly with PageSpace's drive/page structure.
