# Voice Mode Rebuild Epic

**Status**: 🔄 IN PROGRESS
**Goal**: Replace the broken VoiceModeDock-replaces-ChatInput architecture with a floating VoiceCallPanel that layers STT+TTS on top of existing conversations.

## Overview

Voice mode was built as a replacement interface that assumes it can own the conversation loop — but all actual conversation state (streaming, conversationId, page context, messages) lives in the parent chat views. The hands-free loop only works in barge-in mode but defaults to tap-to-speak (no VAD, no auto-loop). The fix is simple: voice becomes a floating call panel that coexists with the chat input, shares the same `sendMessage` path as typing, and defaults to barge-in so the loop actually runs end-to-end.

---

## Fix default interaction mode

Change the default and fallback from `tap-to-speak` to `barge-in` in the Zustand store.

**Requirements**:
- Given `interactionMode` initial state, should default to `'barge-in'` not `'tap-to-speak'`
- Given `loadSettings` finds no stored value, should fall back to `'barge-in'`

---

## Fix state machine in `useVoiceMode`

Patch the three silent failures that kill the hands-free loop.

**Requirements**:
- Given transcript is sent via `onSend()`, should set `voiceState` to `'waiting'` not `'idle'`
- Given `speak()` is called, should set `voiceState` to `'speaking'` before the TTS fetch begins
- Given TTS ends in barge-in mode, should restart listening by reading store state directly (`useVoiceModeStore.getState().isEnabled`) not via stale closure
- Given `interactionMode` is `'tap-to-speak'`, should still run VAD silence auto-stop during recording

---

## Build `VoiceCallPanel.tsx`

New floating panel component replacing `VoiceModeDock`. Does not replace `ChatInput`.

**Requirements**:
- Given voice mode is active, should render as a floating overlay above the chat input, not instead of it
- Given no OpenAI key is configured, should render an inline error message rather than failing silently
- Given AI is streaming, should show `'Waiting for response...'` status
- Given TTS is speaking, should show a barge-in affordance (tap to interrupt)
- Given user closes the panel, should call `disable()` and leave `ChatInput` fully functional

---

## Wire `VoiceCallPanel` into all three chat views

Update `AiChatView`, `GlobalAssistantView`, `SidebarChatTab` to render VoiceCallPanel alongside (not instead of) ChatInput.

**Requirements**:
- Given voice mode is active, should render `<VoiceCallPanel>` above `<ChatInput>` in the same `renderInput` slot
- Given voice mode is inactive, should render only `<ChatInput>` (no change from current)
- Given a voice transcript is sent, should use the same `handleVoiceSend` → `sendMessageWithContext` path as keyboard input

---

## Remove `isVoiceModeAvailable` gate from `InputFooter`

Voice button should always be visible; the error surfaces inside the panel, not by hiding the button.

**Requirements**:
- Given any user, should always render the AudioLines voice button in the footer
- Given voice mode is active, should highlight the button as active
- Given `isVoiceModeAvailable` prop is removed, should not break any existing prop contracts

---

## Delete `VoiceModeDock.tsx`

**Requirements**:
- Given `VoiceModeDock` is no longer imported anywhere, should delete the file and its test
- Given deletion, should have no remaining imports of `VoiceModeDock` across the codebase
