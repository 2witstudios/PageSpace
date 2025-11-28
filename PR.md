## Summary
- Refactored sidebar AI agent control to use Zustand store for consistent tab synchronization
- Added shared types in `src/types/agent.ts` for agent configuration and sidebar state
- Simplified GlobalAssistantView by extracting state management to dedicated hooks
- Added comprehensive test coverage for new hooks and store logic

## Changes
- **useAgentStore**: Extended with sidebar tab management and agent selection state
- **useDashboardContext**: New hook for dashboard-specific context
- **useSidebarAgentState**: Refactored to use Zustand for tab sync
- **AssistantHistoryTab/AssistantSettingsTab**: Updated to use shared types and store
- **GlobalAssistantView**: Simplified from 479 lines, now delegates to focused components
- **PermissionsGrid**: Minor improvements

## Test plan
- [x] Unit tests for `useDashboardContext` hook
- [x] Unit tests for `useAgentStore` Zustand store
- [ ] Manual testing of sidebar tab switching
- [ ] Verify agent selection persists across sidebar toggles
