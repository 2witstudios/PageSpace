# Review Vector: Use Voice Mode

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/components/ai/voice/VoiceModeOverlay.tsx`, `apps/web/src/components/ai/voice/VoiceModeSettings.tsx`, `apps/web/src/hooks/useVoiceMode.ts`, `apps/web/src/hooks/useSpeechRecognition.ts`, `apps/web/src/stores/useVoiceModeStore.ts`, `apps/web/src/app/api/ai/chat/route.ts`, `apps/web/src/lib/ai/core/provider-factory.ts`, `apps/web/src/lib/ai/shared/hooks/useChatTransport.ts`
**Level**: domain

## Context
The voice mode journey begins when the user activates voice input, which opens the VoiceModeOverlay and starts the useSpeechRecognition hook to capture audio from the browser's speech recognition API. Transcribed text is fed into the AI chat transport as a user message, processed through the standard AI chat route with provider factory and streaming response. The AI response text can optionally be spoken back via speech synthesis. This flow crosses the voice UI overlay, browser speech APIs, Zustand voice state management, the AI chat streaming pipeline, and provider abstraction layer.
