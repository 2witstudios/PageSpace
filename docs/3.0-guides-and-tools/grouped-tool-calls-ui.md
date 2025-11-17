# Grouped Tool Calls UI Design

## Overview

The grouped tool calls UI provides a better user experience when AI assistants make multiple consecutive tool calls. Instead of displaying 20+ individual tool call components that disrupt the chat flow, consecutive tool calls are now grouped together with a collapsible interface.

## Key Features

### 1. Automatic Grouping
- **2+ consecutive tool calls** are automatically grouped together
- **Single tool calls** are displayed individually (no grouping overhead)
- **Text parts** separate tool call groups (preserves conversation flow)

### 2. Nested Collapsible Pattern
The design follows a two-level collapsible pattern inspired by Claude's UI:

**Outer Level (Group Summary):**
- Total count: "5 tool calls"
- Status summary: "3 completed, 1 in progress, 1 pending"
- Overall status icon (spinner, checkmark, error, clock)
- Collapsible chevron indicator

**Inner Level (Individual Tools):**
- Each tool call rendered with existing `ToolCallRenderer` or `CompactToolCallRenderer`
- Active tool call highlighted with blue ring and left border
- Preserves all existing tool call details and functionality

### 3. Smart Auto-Expand
Groups automatically expand when:
- Any tool is currently **in progress** (streaming, executing)
- Any tool has an **error** state

This ensures users see important status updates without manual interaction.

### 4. Status Indicators

**Group Status Priority:**
1. ❌ **Error** - if any tool failed
2. 🔵 **In Progress** - if any tool is running
3. ⏳ **Pending** - if any tool is waiting
4. ✅ **Completed** - all tools finished successfully

**Status Icons:**
- 🔵 Spinner (animated) - In progress
- ✅ Green checkmark - Completed
- ❌ Red X - Error
- ⏳ Gray clock - Pending

## Components

### GroupedToolCallsRenderer
**Location:** `apps/web/src/components/ai/GroupedToolCallsRenderer.tsx`

**Purpose:** Groups consecutive tool calls in the main chat interface (full-width)

**Key Props:**
```typescript
interface GroupedToolCallsRendererProps {
  toolCalls: ToolCallPart[];  // Array of consecutive tool calls
  className?: string;
}
```

**Behavior:**
- Renders single tool call directly (no grouping wrapper)
- Groups 2+ tool calls with collapsible container
- Uses shadcn/ui `Collapsible` component
- Highlights active tool with blue ring
- Auto-expands on in_progress or error

### CompactGroupedToolCallsRenderer
**Location:** `apps/web/src/components/ai/CompactGroupedToolCallsRenderer.tsx`

**Purpose:** Groups consecutive tool calls in the compact sidebar interface

**Key Props:**
```typescript
interface CompactGroupedToolCallsRendererProps {
  toolCalls: ToolCallPart[];  // Array of consecutive tool calls
  className?: string;
}
```

**Differences from full version:**
- More compact spacing (p-2 vs p-3, smaller fonts)
- Manual expand state with `useState` instead of `Collapsible`
- Simpler summary text (shows only most relevant status)
- ChevronRight/ChevronDown instead of rotating chevron

## Message Renderer Updates

### MessageRenderer
**Location:** `apps/web/src/components/ai/MessageRenderer.tsx`

**Changes:**
1. Added `ToolCallsGroupPart` type for grouped tools
2. Updated grouping logic to collect consecutive tool calls
3. Renders `GroupedToolCallsRenderer` for 2+ consecutive tools
4. Preserves existing behavior for single tools and text

**Grouping Logic:**
```typescript
const groups: GroupedPart[] = [];
let currentTextGroup: TextPart[] = [];
let currentToolGroup: ToolGroupPart[] = [];

// Iterate through message parts
// - Collect consecutive text parts
// - Collect consecutive tool calls
// - Create groups when type changes

// If 2+ tools: create tool-calls-group
// If 1 tool: add individually
```

### CompactMessageRenderer
**Location:** `apps/web/src/components/ai/CompactMessageRenderer.tsx`

**Changes:**
Same as `MessageRenderer` but uses `CompactGroupedToolCallsRenderer` for rendering.

## User Experience

### Before (20 tool calls)
```
┌─────────────────────┐
│ read_page          │ ← Individual tool 1
├─────────────────────┤
│ read_page          │ ← Individual tool 2
├─────────────────────┤
│ read_page          │ ← Individual tool 3
├─────────────────────┤
...18 more...
└─────────────────────┘
```
**Issues:**
- Massive UI disruption
- Hard to see conversation flow
- Difficult to track progress
- Overwhelming in sidebar

### After (20 tool calls grouped)
```
┌──────────────────────────────────────┐
│ 🔵 20 tool calls                    ∨│ ← Collapsed summary
│    3 completed, 1 in progress, 16... │
└──────────────────────────────────────┘

Click to expand:
┌──────────────────────────────────────┐
│ 🔵 20 tool calls                    ∧│ ← Expanded header
├──────────────────────────────────────┤
│ ┃ ✅ read_page (1)                  │ ← Individual tool (active)
│ │ ✅ read_page (2)                  │
│ │ ✅ read_page (3)                  │
│ │ 🔵 read_page (4)                  │ ← Currently running
│ │ ⏳ read_page (5)                  │ ← Pending
│ │ ...15 more...                     │
└──────────────────────────────────────┘
```
**Benefits:**
- Clean, compact interface
- Clear progress at a glance
- Easy to expand for details
- Active tool prominently shown

## Integration Points

### Where Used

1. **Main AI Chat** (`AiChatView.tsx`)
   - Uses `ConversationMessageRenderer`
   - Which uses `MessageRenderer`
   - Which renders `GroupedToolCallsRenderer`

2. **Right Sidebar Assistant** (`AssistantChatTab.tsx`)
   - Uses `CompactConversationMessageRenderer`
   - Which uses `CompactMessageRenderer`
   - Which renders `CompactGroupedToolCallsRenderer`

3. **Mobile/Responsive**
   - Same components adapt via Tailwind breakpoints
   - Compact version used for narrow screens
   - No iOS-specific implementation needed

### No Changes Required For

- Individual tool call rendering (`ToolCallRenderer`, `CompactToolCallRenderer`)
- Tool call data structures (unchanged)
- AI SDK integration (unchanged)
- Todo list messages (different message type)
- Streaming logic (unchanged)

## Technical Details

### Type Definitions

```typescript
interface ToolCallsGroupPart {
  type: 'tool-calls-group';
  tools: ToolGroupPart[];
}

type GroupedPart = TextGroupPart | ToolGroupPart | ToolCallsGroupPart;
```

### Grouping Threshold
- **Minimum 2 tools** required for grouping
- **Single tools** render individually
- Configurable via component logic

### State Management
- **Full version**: Uses shadcn/ui `Collapsible` with `defaultOpen`
- **Compact version**: Uses `useState(isExpanded)` with manual toggle
- Auto-expand effect watches for in_progress/error states

### Performance
- **Memoization**: `useMemo` for grouping logic and status calculations
- **No re-renders**: Grouping happens once per message.parts change
- **Lazy rendering**: Collapsed groups don't render inner content

## Future Enhancements

### Potential Improvements
1. **Configurable grouping threshold** - Allow users to set minimum group size
2. **Group by tool type** - Optionally group "read_page" separately from "create_page"
3. **Progress bars** - Show completion percentage for large groups
4. **Keyboard shortcuts** - Expand/collapse with hotkeys
5. **Virtualization** - For extremely large tool call groups (100+)
6. **Animations** - Smooth expand/collapse transitions

### Accessibility
- Consider ARIA labels for screen readers
- Keyboard navigation support
- Focus management on expand/collapse

## Migration Notes

### Breaking Changes
None - this is a purely additive UI enhancement.

### Backwards Compatibility
- Existing tool calls work unchanged
- Single tool calls render identically
- No API changes required
- No database migrations needed

### Testing Recommendations
1. Test with various group sizes (2, 5, 10, 20+ tools)
2. Verify auto-expand on errors
3. Check active tool highlighting
4. Test in main chat and sidebar
5. Verify responsive behavior
6. Test with mixed text/tool message parts
7. Ensure collapsed state persists correctly

## Design Rationale

### Why Group at 2+ Tools?
- Single tool calls are already compact enough
- Grouping overhead isn't worth it for just one tool
- Matches user mental model (multiple = batch operation)

### Why Auto-Expand on Errors?
- Users need to see errors immediately
- Prevents silent failures
- Matches existing error handling patterns

### Why Highlight Active Tool?
- Shows what the AI is currently doing
- Provides visual feedback during long operations
- Helps users understand streaming progress

### Why Two Versions (Full + Compact)?
- Sidebar has limited width (requires different layout)
- Different information density needs
- Maintains existing UI patterns
- Better performance (no responsive switching)
