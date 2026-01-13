# Chat Performance Optimization Plan (PageSpace)

## Problem restatement
PageSpace AI chat has two main performance issues:
1) Long conversations (100+ messages) cause UI lag.
2) Streaming responses feel chunky.

## Codebase observations (from repo)
- Message rendering is not virtualized in `apps/web/src/components/ai/shared/chat/ChatMessagesArea.tsx` (main chat) or `apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarChatTab.tsx` (sidebar). Both map the full `messages` array.
- Auto-scroll is unconditional (scrollTop to scrollHeight on every message or stream update) in `ChatMessagesArea.tsx` and `SidebarChatTab.tsx`, which can cause layout thrash and fights user scroll.
- `ChatMessagesArea` is used by `ChatLayout` in both `AiChatView` and `GlobalAssistantView`. The sidebar uses `CompactMessageRenderer` and its own list in `SidebarChatTab.tsx`.
- Send handlers call `scrollToBottom` with a timeout after `sendMessage` in `AiChatView.tsx`, `GlobalAssistantView.tsx`, and `SidebarChatTab.tsx`.
- Global messages are stored in `messages` (schema: `packages/db/src/schema/conversations.ts`) and fetched via `/api/ai/global/[id]/messages` with cursor support and `createdAt` ordering (`apps/web/src/app/api/ai/global/[id]/messages/route.ts`).
- Agent messages are stored in `chat_messages` (schema: `packages/db/src/schema/core.ts`) and fetched via `/api/ai/page-agents/[agentId]/conversations/[conversationId]/messages`, which currently returns the full conversation (`apps/web/src/app/api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/route.ts`).
- Global chat loads the latest 50 messages on open (`apps/web/src/contexts/GlobalChatContext.tsx`). Agent chats load all messages because `fetchAgentConversationMessages` has no limit (`apps/web/src/lib/ai/shared/agent-conversations.ts`).
- Agent message loads flow through `usePageAgentDashboardStore` and `usePageAgentSidebarState` (both call `fetchAgentConversationMessages`), so pagination changes must update those stores.
- `useChat` is throttled to 100 ms for agent chats in `apps/web/src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx`, `apps/web/src/components/layout/middle-content/page-views/dashboard/GlobalAssistantView.tsx` (agent config), and `apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarChatTab.tsx` (agent config). Global mode uses the default throttle (no override in `GlobalChatContext`).
- `StreamingMarkdown` already uses Streamdown, memoization, and module-scope mention regex in `apps/web/src/components/ai/shared/chat/StreamingMarkdown.tsx`, so streaming chunkiness is more likely from throttle + scroll behavior than markdown parsing.
- `MessageRenderer` and `CompactMessageRenderer` are memoized and already use `content-visibility`, but tool call renderers are not memoized (`apps/web/src/components/ai/shared/chat/tool-calls/*.tsx`).
- `ScrollArea` is Radix-based and the scroll element is the Viewport (`apps/web/src/components/ui/scroll-area.tsx`), so virtualization must attach to that element.
- Conversation history lists are not virtualized. Agent list endpoints already support page/pageSize (`apps/web/src/app/api/ai/page-agents/[agentId]/conversations/route.ts`), but the UI does not use them. Global history endpoint returns all conversations (`apps/web/src/app/api/ai/global/route.ts`).
- Global history data comes from `globalConversationRepository.listConversations` (no limit) and is used by `SidebarHistoryTab.tsx` and `useConversations` (global mode).
- A pinned-scroll helper already exists in `apps/web/src/components/ai/ui/conversation.tsx` (use-stick-to-bottom) but is not wired into the chat surfaces.

## Optimization strategy (epics)

### Epic 1: Virtualized message lists with pinned scrolling (P0, high impact)
Problem: All messages render at once in both main chat and sidebar, and auto-scroll runs on every update.

Solution: Introduce windowed rendering with pinned-to-bottom behavior and a scroll-to-bottom button.

Targets:
- `apps/web/src/components/ai/shared/chat/ChatMessagesArea.tsx`
- `apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarChatTab.tsx`
- Reuse `apps/web/src/components/ai/ui/conversation.tsx` (use-stick-to-bottom) for pinned state and scroll button.

Tasks:
- Add `@tanstack/react-virtual` (not currently in deps) and create a shared `VirtualizedMessageList` component that supports variable row heights and reverse growth.
- Replace `messages.map` with a virtualizer in `ChatMessagesArea.tsx` and `SidebarChatTab.tsx`. Keep `StreamingIndicator` and `UndoAiChangesDialog` intact.
- Attach the virtualizer to the Radix `ScrollArea` viewport element (the `ref` in `ScrollArea` points to the viewport).
- Track `isPinnedToBottom` and only auto-scroll while pinned. Use `ConversationScrollButton` when not pinned.
- On send: scroll to the last user message bottom (anchor) and keep pinned while streaming.
- On first render: scroll to the latest message and set pinned.
- Use `ResizeObserver` or `virtualizer.measureElement` to keep row sizes updated as streaming content grows.
- Preserve scroll position when prepending older messages (see Epic 2).

Expected gain: major reduction in DOM nodes and layout thrash for 100+ message threads.

### Epic 2: Cursor-based message pagination for global and agent chats (P0, high impact)
Problem: Agent conversations load all messages. Global loads only the newest page but cannot fetch earlier messages.

Solution: Paginate both global and agent message loading and implement "load earlier messages" on scroll-to-top.

Targets:
- API: `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/route.ts`
- API: `apps/web/src/app/api/ai/global/[id]/messages/route.ts` (already supports cursor)
- Client: `apps/web/src/lib/ai/shared/agent-conversations.ts`, `apps/web/src/lib/ai/shared/hooks/useConversations.ts`
- Client stores: `apps/web/src/stores/page-agents/usePageAgentDashboardStore.ts`, `apps/web/src/hooks/page-agents/usePageAgentSidebarState.ts`
- Client: `apps/web/src/contexts/GlobalChatContext.tsx`
- Message actions: `apps/web/src/lib/ai/shared/hooks/useMessageActions.ts`

Tasks:
- Add cursor/limit support to the agent messages API, mirroring the global API contract (limit, cursor, direction, pagination meta) and using `createdAt` + `id` for stable ordering (avoid duplicate timestamps).
- Keep response order chronological (oldest-first) to match current UI expectations (global route already reverses after a DESC query).
- Create a `useConversationMessages` hook that manages pages, cursors, and "load older" calls.
- Update global chat load to start with `limit=50` (already done in `GlobalChatContext`) but add a path to fetch older messages using `pagination.nextCursor` (the oldest returned message id) with `direction=before`.
- Update agent chat load to start with `limit=50` and support prepending older batches in `usePageAgentDashboardStore` and `usePageAgentSidebarState`.
- Implement a top sentinel or virtualizer range check to trigger load-older; preserve scroll position when prepending.
- Update `useMessageActions` so edit/undo/refresh do not fetch the entire conversation in agent mode. Prefer targeted updates or re-fetch the current window only.
- Ensure undo and refresh paths rehydrate pagination state consistently.

Expected gain: instant conversation open and smooth scroll for large histories.

### Epic 3: Streaming smoothness and scroll behavior (P1, medium impact)
Problem: Streaming feels chunky and scroll jittery.

Solution: Tune throttle and reduce scroll churn during streaming.

Targets:
- `apps/web/src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx`
- `apps/web/src/components/layout/middle-content/page-views/dashboard/GlobalAssistantView.tsx` (agent config)
- `apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarChatTab.tsx` (agent config)
- `apps/web/src/components/ai/shared/chat/ChatMessagesArea.tsx`
- `apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarChatTab.tsx`

Tasks:
- Measure and adjust `experimental_throttle` (100 ms today) for agent chats. Consider 50 ms or adaptive throttling (lower during short responses, higher for very long streams). Global mode currently uses default throttle via `GlobalChatContext`.
- If a lower throttle helps, apply the same `experimental_throttle` to global chat config in `GlobalChatContext.tsx` for consistent feel.
- Remove unconditional `scrollToBottom` effects; rely on pinned state (Epic 1) to avoid repeated layout thrash.
- Replace `setTimeout(...scrollToBottom, 100)` calls after send with a pinned scroll that runs after layout/measure completes.
- Keep `StreamingMarkdown` as-is; it already uses Streamdown and memoization. Only revisit if profiling shows markdown parse costs dominate.

Expected gain: smoother perceived streaming without spiking CPU.

### Epic 4: Tool renderer memoization and render isolation (P1, medium impact)
Problem: Tool-call rows can re-render frequently during streaming, even when content is static.

Solution: Memoize tool call renderers and stabilize props.

Targets:
- `apps/web/src/components/ai/shared/chat/tool-calls/ToolCallRenderer.tsx`
- `apps/web/src/components/ai/shared/chat/tool-calls/CompactToolCallRenderer.tsx`
- `apps/web/src/components/ai/shared/chat/tool-calls/DocumentRenderer.tsx`
- `apps/web/src/components/ai/shared/chat/tool-calls/FileTreeRenderer.tsx`
- `apps/web/src/components/ai/shared/chat/tool-calls/TaskRenderer.tsx`

Tasks:
- Wrap tool renderers in `React.memo`.
- Use `useMemo` for expensive JSON parsing in `ToolCallRenderer` and `CompactToolCallRenderer`.
- Ensure parent props are stable (avoid inline object literals where possible).

Expected gain: fewer wasted renders during streaming.

### Epic 5: Conversation history list optimization (P2, lower impact)
Problem: History lists can be large and global history endpoint returns all conversations.

Solution: Paginate and virtualize history lists.

Targets:
- `apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarHistoryTab.tsx`
- `apps/web/src/components/ai/page-agents/PageAgentHistoryTab.tsx`
- API: `apps/web/src/app/api/ai/global/route.ts` (add pagination)

Tasks:
- Add pagination to `/api/ai/global` list endpoint (page/pageSize or cursor) in `apps/web/src/app/api/ai/global/route.ts`.
- Use existing page/pageSize for agent history UI requests in `SidebarHistoryTab.tsx` and `PageAgentHistoryTab.tsx`.
- Virtualize long history lists and keep the existing search filter (already present in `SidebarHistoryTab.tsx`). Note: client-side search should either apply to loaded pages only or trigger a server-side search.
- Cache conversation metadata in SWR or Zustand to avoid repeated full refetches.

Expected gain: smoother sidebar history interactions with large datasets.

## Scroll behavior compatibility checklist
- Scroll to bottom on first render: implement once after initial measurements.
- Scroll-to-bottom button: use `ConversationScrollButton` when not pinned.
- On send: anchor to the last user message bottom; keep pinned as streaming grows.
- If user scrolls up: stop auto-scroll, continue rendering without forcing position.

## Risks and mitigations
- Reverse scroll plus variable height virtualization can be tricky. Mitigation: use `@tanstack/react-virtual` with `measureElement` and a pinned-to-bottom state via `use-stick-to-bottom`.
- Cursor collisions: global pagination uses `createdAt` only today. Mitigation: include `id` in cursor ordering for both `messages` and `chat_messages` to avoid duplicates/holes when timestamps match.
- Prepending older messages can shift scroll. Mitigation: capture scroll offset or virtualizer range and restore after prepend.
- Agent edit/undo flows currently re-fetch all messages. Mitigation: update `useMessageActions` to patch or reload only the current window after edits/deletes.
- Offscreen unmounting may pause task socket listeners (`todo_list` messages). Mitigation: keep a small overscan or move task updates to a store if live updates are required offscreen.
- Global mode has two message sources: `GlobalAssistantView` local `useChat` state and `GlobalChatContext` (used by `SidebarChatTab`). Mitigation: pagination and edits must update both the context and the local `useChat` messages to avoid divergence.
- Agent mode in dashboard uses `usePageAgentDashboardStore` plus local `useChat` state in `GlobalAssistantView`. Mitigation: treat the store as the canonical list and push pagination updates through it.

## Priority and execution order
Phase 1 (quick wins):
1) Epic 4: tool renderer memoization
2) Epic 3: streaming throttle tuning (small change, measurable)

Phase 2 (core changes):
3) Epic 2: cursor-based pagination (agent and global)
4) Epic 1: message list virtualization plus pinned scrolling

Phase 3 (polish):
5) Epic 5: conversation history pagination plus virtualization

## Validation
- Profile 100, 250, 500 message threads for FPS and commit durations.
- Track DOM node count and scroll latency before and after.
- Verify pinned scrolling behaviors (first render, send, manual scroll, scroll-to-bottom button).
- Validate pagination integrity (no duplicates/holes), including same-timestamp messages.
- Verify edit/delete/undo flows update the current window without forcing full reloads.
