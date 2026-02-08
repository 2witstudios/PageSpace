# Review Vector: Voice Mode

## Standards
- review.mdc
- javascript.mdc
- please.mdc

## Scope
**Files**: `apps/web/src/stores/useVoiceModeStore.ts`, `apps/web/src/components/ai/**`, `apps/web/src/app/api/voice/**`
**Level**: domain

## Context
Voice mode provides speech-to-text input and text-to-speech output for AI conversations, managed through a dedicated Zustand store that tracks recording state, audio playback, and voice preferences. The voice API routes handle audio transcription and synthesis via external providers. Voice controls are hidden on mobile devices, and the system must cleanly degrade when audio APIs are unavailable.
