# Component Organization Philosophy

### `/components/` Directory Structure

```
/components/
├── ui/                     # Pure shadcn/ui framework components
├── providers/              # Global context providers (ThemeProvider, SuggestionProvider, etc.)
├── shared/                 # Simple reusable components across contexts
├── layout/                 # Main structural application layout (e.g., left-sidebar, middle-content, right-sidebar)
├── messages/               # Universal message handling & input
├── mentions/               # Entity mention system components (e.g., SuggestionPopup)
├── dialogs/                # Custom application-specific dialogs
├── admin/                  # Administrative components for user and schema management
├── ai/                     # AI-specific UI components and renderers
├── canvas/                 # Canvas dashboard components (ShadowCanvas)
├── editors/                # Rich text and code editor components
├── members/                # Drive member and collaboration management components
├── notifications/          # Notification system components
├── sandbox/                # Preview and sandbox safety components
└── ...feature-specific/    # Other feature-based directories
```

### `/packages/` Directory Structure

```
/packages/
├── db/                     # Drizzle ORM schema and database utilities
└── lib/                    # Shared libraries and utilities
```

### Organizational Principles

#### 1. Scope-Based Organization
Components are organized by **scope and usage context**, not implementation details:
- **Global scope**: `/ui/`, `/providers/`, `/shared/`
- **Layout scope**: `/layout/` with clear visual hierarchy (e.g., `left-sidebar`, `middle-content`, `right-sidebar`)
- **Feature scope**: `/messages/`, `/mentions/`, `/ai/`
- **Interaction Scope**: `/dialogs/` for application-specific modals and pop-ups.

#### 2. Usage-Driven Naming
Directory names reflect **what they're used for**, not how they're built:
- ✅ `/editors/` - Rich text and code editing components used across documents, messages, etc.
- ✅ `/messages/` - Handles messaging across AI chats, channels, DMs
- ✅ `/mentions/` - Manages entity mentions across all contexts
- ✅ `/admin/` - Administrative interface components for system management
- ✅ `/members/` - Drive collaboration and member management features
- ❌ `/chat/` - Ambiguous, conflicts with API terminology

#### 3. Framework vs Application Separation
Clear separation between framework components and application logic:
- **Framework components** (`/ui/`): Pure shadcn/ui, no application logic
- **Application components** (other directories): Custom logic, business rules
- **Core Packages** (`/packages/`): Reusable, isolated packages with their own dependencies.

#### 4. Future-Proof Structure
Organization anticipates growth and new features:
- Editor components in `/editors/` can be used for any rich text or code editing needs.
- Message components handle forums, notifications, any messaging.
- Mention system supports new entity types without restructuring.
- Administrative components in `/admin/` provide system management interfaces.
- Member management components support collaboration across all drive types.
- Notification system components handle alerts and real-time updates.
- Sandbox components ensure safe preview and execution environments.
- `workspace-selector.tsx` is the file for the `DriveSwitcher` component, located under `left-sidebar/`.
- Page settings components like `ShareDialog` and `PermissionsList` are located under `middle-content/content-header/page-settings/`.
- The `PageType` enum includes `FOLDER`, `DOCUMENT`, `CHANNEL`, `AI_CHAT`, `CANVAS`, `FILE`, and `SHEET`.
