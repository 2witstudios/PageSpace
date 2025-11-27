# Layout Architecture

### UI Layout Philosophy

pagespace follows a **five-section layout** that provides consistent, predictable placement for all features:

```
┌─────────────────────────────────────────────────────────────┐
│                    📱 Main Header (Universal)                │
│  Global search, notifications, user menu, account settings  │
├─────────────┬───────────────────────────────┬───────────────┤
│             │        📄 Middle Header       │               │
│             │   Page title, actions, collab │               │
│  🧭 Left    ├───────────────────────────────┤  ⚙️ Right     │
│  Sidebar    │                               │  Sidebar      │
│             │        💼 Middle Content      │               │ 
│  Navigation │     Primary work area         │  Contextual   │
│  & Tree     │   (adapts to page type)       │  Settings     │
│             │                               │               │
│             │                               │               │
└─────────────┴───────────────────────────────┴───────────────┘
```

#### 📱 Main Header (Universal)
**Purpose**: Global application controls that persist across all pages  
**What goes here**: Global search, notifications, user menu, account settings  
**Examples**: Search across all workspaces, logout button, theme toggle  
**Component**: `/layout/main-header/`

#### 🧭 Left Sidebar (Navigation)
**Purpose**: Primary navigation and workspace organization  
**What goes here**: Workspace selector, page tree, navigation controls  
**Examples**: Project switcher, folder structure, "New Page" button  
**Component**: `/layout/left-sidebar/`
- `page-tree/` - Hierarchical page navigation
- `workspace-selector.tsx` - Drive/workspace switching

#### 📄 Middle Header (Shared across page views)
**Purpose**: Page-specific actions and metadata  
**What goes here**: Page title, page actions, collaboration info  
**Examples**: Share button, live viewer count, breadcrumbs  
**Component**: `/layout/middle-content/content-header/`

#### 💼 Middle Content (Primary work area)
**Purpose**: The main interactive content that adapts to page type  
**What goes here**: Text editor, database table, chat messages, folder contents  
**Examples**: Document editor, AI chat interface, file browser  
**Component**: `/layout/middle-content/page-views/`
- `document/` - Rich text document editing
- `ai-page/` - AI chat interface
- `channel/` - People group conversations
- `folder/` - Directory listing view
- `canvas/` - Canvas dashboard view with functional HTML/CSS navigation
- `dashboard/` - Dashboard and global assistant views
- `settings/` - Application settings (AI API, MCP configuration)

#### ⚙️ Right Sidebar (Contextual)
**Purpose**: Page-specific settings and contextual tools
**What goes here**: Page-specific settings, AI assistant, related info
**Examples**: AI chat, page permissions, activity feed
**Component**: `/layout/right-sidebar/`
- `ai-assistant/` - Personal AI assistant
- `page-settings/` - Sharing, permissions, activity

### Component Placement Guidelines

#### Where to Place New Features

**Global Features** → Main Header
- Authentication controls
- Universal search
- User settings
- Notifications

**Navigation Features** → Left Sidebar  
- Workspace management
- Page organization
- Quick access controls
- Drive/folder operations

**Content Features** → Middle Content
- New page types (database, kanban, etc.)
- Content editing interfaces
- Data visualization
- Interactive tools

**Contextual Features** → Right Sidebar
- Page-specific settings
- Related information panels
- Collaboration tools
- Activity feeds

#### Decision Matrix for New Components

| Feature Type | Main Header | Left Sidebar | Middle Content | Right Sidebar |
|--------------|-------------|--------------|----------------|---------------|
| **Global scope** | ✅ | ❌ | ❌ | ❌ |
| **Navigation** | ❌ | ✅ | ❌ | ❌ |
| **Primary content** | ❌ | ❌ | ✅ | ❌ |
| **Page-specific** | ❌ | ❌ | ❌ | ✅ |
| **Always visible** | ✅ | ✅ | ❌ | ❌ |
| **Context-dependent** | ❌ | ❌ | ✅ | ✅ |

### Visual Hierarchy Mapping

The `/layout/` directory directly maps to this visual structure:

```
/layout/
├── DebugPanel.tsx         # Development debugging interface
├── Layout.tsx             # Main layout wrapper component
├── LayoutErrorBoundary.tsx # Error handling for layout components
├── NavigationProvider.tsx # Navigation context provider
├── main-header/           # 📱 Universal top navigation bar
├── left-sidebar/          # 🧭 Primary navigation & page tree
│   ├── page-tree/         # Hierarchical page navigation
│   └── workspace-selector.tsx
├── middle-content/        # 💼 Adaptive main content area
│   ├── content-header/    # 📄 Page title, actions, breadcrumbs
│   └── page-views/        # Different content types
│       ├── document/      # Rich text document editing
│       ├── ai-page/       # AI chat interface
│       ├── channel/       # People group conversations
│       ├── folder/        # Directory listing view
│       ├── canvas/        # Canvas dashboard with HTML/CSS navigation
│       ├── dashboard/     # Dashboard and global assistant
│       └── settings/      # Application settings (AI API, MCP)
└── right-sidebar/         # ⚙️ Contextual information & tools
    ├── ai-assistant/      # Personal AI assistant
    └── page-settings/     # Sharing, permissions, activity
```

### Layout Design Principles
- **🎯 Predictable placement**: Each UI element has a logical, consistent home
- **📱 Context-appropriate**: Right sidebar and middle content adapt to current page/view
- **🔄 Consistent patterns**: Similar features appear in similar locations across the app
- **⚡ Performance-conscious**: Layout sections can load independently
- **♿ Accessibility-first**: Clear navigation hierarchy and keyboard support