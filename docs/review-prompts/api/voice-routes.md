# Review Vector: Voice Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/voice/**/route.ts`
**Level**: route

## Context
Voice routes provide speech-to-text transcription and text-to-speech synthesis for the voice interaction mode. The transcribe endpoint accepts audio blobs and returns text via an AI provider, while the synthesize endpoint converts AI responses to audio streams. Both endpoints handle binary data and streaming responses, requiring proper content-type headers and error handling for provider timeouts. Voice features are hidden on mobile devices but active on desktop, so these routes should still validate authentication and subscription tier access.
