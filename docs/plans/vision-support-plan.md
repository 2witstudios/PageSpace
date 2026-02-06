# Vision Support Implementation Plan

## Overview

Enable vision-capable AI models in PageSpace to receive and process images directly in chat messages. Users should be able to attach images (via paste, drag-drop, or file picker) to their chat input, and have those images sent to vision models alongside their text prompt.

This plan covers **Phase 1: Direct Image Upload to Chat** (images attached to user messages). Phase 2 (AI reading images from the drive via tool calling) is deferred as a separate effort.

---

## Current State Analysis

### What Already Exists (Significant Head Start)

1. **`PromptInput` UI component** (`apps/web/src/components/ai/ui/prompt-input.tsx`)
   - Full attachment management with `AttachmentsContext` (add, remove, clear)
   - File picker via hidden `<input type="file">`
   - Clipboard paste handling (`handlePaste` on textarea)
   - Drag-and-drop handling (form-level and global)
   - Blob URL → data URL conversion on submit
   - Attachment previews with hover cards
   - Max file count/size validation
   - **NOT currently used by the AI chat** - only exists as a reusable UI primitive

2. **Image validation** (`apps/web/src/lib/validation/image-validation.ts`)
   - Zero-trust server-side validation
   - Magic byte verification for JPEG, PNG, GIF, WebP
   - Data URL parsing and MIME type cross-checking

3. **Model capabilities system** (`apps/web/src/lib/ai/core/model-capabilities.ts`)
   - `hasVisionCapability(model)` with 62+ models flagged
   - `getModelCapabilities()` returns `{ hasVision, hasTools }`
   - Capabilities passed to `streamText()` via `experimental_context`
   - Pattern-based fallback detection for unknown models

4. **AI SDK `FileUIPart` type** (from `ai` package)
   - `{ type: 'file', url: string, mediaType?: string, filename?: string }`
   - `useChat().sendMessage()` accepts `{ text, files }` where files are `FileUIPart[]`
   - `convertToModelMessages()` automatically converts `file` parts with `image/*` mediaType into provider-specific image content

5. **Processor service image optimization** (`apps/processor/`)
   - `ai-vision` preset: 2048px max, JPEG q90
   - `ai-chat` preset: 1920px max, JPEG q85
   - Already has `POST /api/optimize/prepare-for-ai` endpoint

6. **Message parts architecture**
   - Messages use `parts[]` array supporting `text`, `tool-*`, `step-start` types
   - Database stores structured content with `partsOrder` for chronological reconstruction
   - `file` part type exists in AI SDK but **is not yet handled** in PageSpace's save/load logic

### What's Missing

| Gap | Impact |
|-----|--------|
| ChatInput/ChatTextarea has no attachment support | Users can't attach images |
| `sendMessageWithContext()` only passes `{ text }` | Files never reach the API |
| Chat route doesn't handle `file` parts in user messages | Images not saved or forwarded |
| `saveMessageToDatabase()` ignores `file` parts | Image data lost on reload |
| `convertDbMessageToUIMessage()` doesn't reconstruct `file` parts | Images not restored from DB |
| MessageRenderer has no `file`/image part rendering | Images not visible in chat |
| No vision capability check in UI to show/hide attachment button | UX confusion with non-vision models |
| No image size limits for AI input | Risk of oversized payloads |

---

## Architecture Decision: Data URLs vs. Stored Files

**Decision: Use data URLs for Phase 1, with optimization.**

**Rationale:**
- The AI SDK's `FileUIPart` uses `url` field (data URL or https URL)
- `convertToModelMessages()` automatically handles data URLs for all providers
- Provider APIs (OpenAI, Anthropic, Google, xAI) all accept base64-encoded images
- Avoids complex file storage → URL serving → AI fetching pipeline
- Image optimization via processor service keeps payload size manageable

**Flow:**
```
User attaches image
  → Client creates blob URL (for local preview)
  → On send: blob URL → data URL conversion (already in PromptInput)
  → Client sends message with file parts containing data URLs
  → Server validates image (magic bytes, size, type)
  → Server saves optimized data URL to database (or content hash reference)
  → Server passes file parts to convertToModelMessages()
  → AI SDK handles provider-specific formatting automatically
```

**Image size optimization strategy:**
- Client-side: Resize images > 2048px before conversion to data URL
- Server-side: Validate size < 4MB per image after base64 encoding
- For large images: Use processor service `ai-vision` preset
- Store content hash reference in DB instead of full data URL (for efficiency)

---

## Implementation Plan

### Layer 1: Frontend - Chat Input Attachments

**Files to modify:**
- `apps/web/src/components/ai/chat/input/ChatInput.tsx`
- `apps/web/src/components/ai/chat/input/ChatTextarea.tsx`
- `apps/web/src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx`

**Changes:**

#### 1.1 Add attachment state to AiChatView
- Add `useState` for `attachedFiles: (FileUIPart & { id: string })[]`
- Add `addFiles`, `removeFile`, `clearFiles` functions
- Implement client-side image resize (canvas-based, max 2048px)
- Pass attachment state and handlers to ChatInput

#### 1.2 Extend ChatInput with attachment support
- Add new props: `attachments`, `onAddAttachments`, `onRemoveAttachment`, `onClearAttachments`, `hasVision`
- Add "Attach image" button (paperclip icon) in footer, visible when model `hasVision`
- Add hidden `<input type="file" accept="image/*">` for file picker
- Add paste handler to ChatTextarea (intercept image pastes from clipboard)
- Add drag-and-drop handler to chat input area
- Render attachment preview strip above textarea (using existing `PromptInputAttachment` component or similar pattern)
- Show image thumbnails with remove buttons

#### 1.3 Update sendMessageWithContext to include files
- Change signature: `sendMessageWithContext(text: string, files?: FileUIPart[])`
- Convert blob URLs to data URLs before sending (reuse pattern from `PromptInput`)
- Pass files to `sendMessage({ text, files }, { body: {...} })`
- Clear attachments after successful send

#### 1.4 Vision capability awareness in UI
- Fetch model capabilities (already available via `hasVisionCapability()`)
- Pass `hasVision` boolean down to ChatInput
- Show/hide attachment button based on vision support
- Show tooltip "This model doesn't support images" when hovering attachment button on non-vision models
- Allow attaching anyway (with warning) since model might change before send

---

### Layer 2: Backend - API Route Handling

**Files to modify:**
- `apps/web/src/app/api/ai/chat/route.ts`

**Changes:**

#### 2.1 Extract and validate image parts from user message
- When extracting the user message (`messages[messages.length - 1]`), detect `file` parts
- For each `file` part with `image/*` mediaType:
  - Validate using `validateImageAttachment()` (magic bytes check)
  - Enforce size limit (4MB per image, 10MB total per message)
  - Enforce count limit (max 5 images per message)
- Reject invalid images with descriptive error

#### 2.2 Check model vision capability before streaming
- After resolving the model, check `hasVisionCapability(currentModel)`
- If user message contains images but model lacks vision:
  - Return 400 error: "The selected model does not support image inputs"
  - Include `suggestedModels` from `getSuggestedVisionModels()`

#### 2.3 Ensure file parts flow through to AI model
- The key insight: `convertToModelMessages()` already handles `file` parts
- The conversation history loaded from DB must include file parts (see Layer 3)
- The last user message from the client already includes file parts via `UIMessage.parts`
- Verify `sanitizeMessagesForModel()` preserves `file` parts (it currently filters tool parts only)

---

### Layer 3: Database Persistence

**Files to modify:**
- `apps/web/src/lib/ai/core/message-utils.ts`
- `apps/web/src/app/api/ai/chat/route.ts` (user message save section)

**Changes:**

#### 3.1 Save image references in user messages
- When saving user message to database, store image data alongside text
- **Option A (recommended): Store optimized data URLs directly**
  - For small images (< 500KB data URL): store inline in structured content
  - For larger images: save to processor storage, store content hash reference
- **Option B: Always save to storage, store content hash**
  - Send image data to processor service for storage
  - Store `{ type: 'file', contentHash, mediaType, filename }` in structured content
  - Reconstruct data URL from processor when loading conversation

- Update `saveMessageToDatabase()` to recognize and preserve `file` parts in `partsOrder`
- Update structured content format:
  ```typescript
  {
    textParts: [...],
    fileParts: [
      { mediaType: 'image/jpeg', url: 'data:...', filename: 'photo.jpg' }
      // or { mediaType: 'image/jpeg', contentHash: 'abc123', filename: 'photo.jpg' }
    ],
    partsOrder: [
      { index: 0, type: 'text' },
      { index: 1, type: 'file', fileIndex: 0 },  // New: file part reference
      { index: 2, type: 'text' },
    ],
    originalContent: "text content"
  }
  ```

#### 3.2 Reconstruct file parts when loading conversation history
- Update `convertDbMessageToUIMessage()` to reconstruct `file` parts
- When a `partsOrder` entry has `type: 'file'`:
  - Look up corresponding entry in `fileParts`
  - Create `FileUIPart` with the stored data URL or resolve from content hash
- Ensure reconstructed messages include file parts so `convertToModelMessages()` includes them

#### 3.3 Handle user message save in chat route
- Currently saves only `extractMessageContent(userMessage)` (text only)
- Update to also save the full UIMessage with file parts
- Use the same structured content approach as assistant messages

---

### Layer 4: Message Rendering

**Files to modify:**
- `apps/web/src/components/ai/shared/chat/MessageRenderer.tsx`
- `apps/web/src/components/ai/shared/chat/message-types.ts`
- `apps/web/src/components/ai/shared/chat/useGroupedParts.ts`

**Changes:**

#### 4.1 Add FilePart type to message types
- Add `FilePart` to the type definitions:
  ```typescript
  interface FilePart {
    type: 'file';
    url: string;
    mediaType?: string;
    filename?: string;
  }
  ```
- Update `GroupedPart` union type to include file parts
- Update type guards

#### 4.2 Update useGroupedParts to handle file parts
- File parts should NOT be grouped with text parts
- Each file part should be its own group entry (or adjacent images grouped together)
- Maintain chronological order with text parts

#### 4.3 Create ImageAttachment rendering component
- New component for rendering image attachments in messages
- Thumbnail view in the message bubble
- Click to expand (lightbox/modal)
- Shows filename and media type on hover
- Handles loading/error states
- Works for both user and assistant messages (future: assistant could include images)

#### 4.4 Update TextBlock to render adjacent images
- When a user message contains both text and images:
  - Render text as normal
  - Render image thumbnails below or above text (maintain chronological part order)
- Style: Images in a row/grid within the user message bubble

---

### Layer 5: Global Assistant Support

**Files to modify:**
- `apps/web/src/app/api/ai/global/[id]/messages/route.ts`
- `apps/web/src/components/ai/global-assistant/GlobalAssistantChat.tsx`
- Global assistant input components

**Changes:**

#### 5.1 Apply same patterns to global assistant
- The global assistant uses a separate API route but similar architecture
- Apply the same image handling to the global assistant's chat input
- Apply the same message persistence changes
- The global assistant may use a different ChatInput variant - ensure compatibility

---

### Layer 6: Sidebar Agent Chat Support

**Files to modify:**
- Sidebar chat input components
- Page agent sidebar hooks

**Changes:**

#### 6.1 Apply same patterns to sidebar agent chats
- Page agents that appear in the sidebar should also support image attachments
- Reuse the same ChatInput attachment components
- Pass vision capability based on the agent's configured model

---

## File-by-File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `apps/web/src/components/ai/chat/input/ChatInput.tsx` | **Modify** | Add attachment props, file picker button, attachment preview strip |
| `apps/web/src/components/ai/chat/input/ChatTextarea.tsx` | **Modify** | Add paste handler for images, drag-drop support |
| `apps/web/src/components/ai/chat/input/ImageAttachmentPreview.tsx` | **New** | Attachment thumbnail strip component with remove buttons |
| `apps/web/src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx` | **Modify** | Add attachment state, pass files to sendMessage, vision capability check |
| `apps/web/src/lib/ai/shared/hooks/useImageAttachments.ts` | **New** | Shared hook for attachment state management, resize, blob→dataURL |
| `apps/web/src/lib/ai/shared/utils/image-resize.ts` | **New** | Client-side canvas-based image resize utility (max 2048px) |
| `apps/web/src/app/api/ai/chat/route.ts` | **Modify** | Validate image parts, check vision capability, save user message with files |
| `apps/web/src/lib/ai/core/message-utils.ts` | **Modify** | Save/load file parts in structured content, update partsOrder handling |
| `apps/web/src/components/ai/shared/chat/message-types.ts` | **Modify** | Add FilePart type, update GroupedPart union |
| `apps/web/src/components/ai/shared/chat/useGroupedParts.ts` | **Modify** | Handle file parts in grouping logic |
| `apps/web/src/components/ai/shared/chat/MessageRenderer.tsx` | **Modify** | Render image parts in messages |
| `apps/web/src/components/ai/shared/chat/ImageMessageContent.tsx` | **New** | Image rendering component for chat messages (thumbnail + lightbox) |
| `apps/web/src/lib/validation/image-validation.ts` | **Modify** | Add size limit constants, add `validateImageForAI()` function |
| `apps/web/src/app/api/ai/global/[id]/messages/route.ts` | **Modify** | Apply same image handling to global assistant route |

---

## Key Technical Considerations

### 1. Data URL Size vs. Database Storage
- A 2048px JPEG at q85 is ~150-400KB → ~200-530KB as base64 data URL
- Storing data URLs in the `content` column (text) is feasible for PostgreSQL
- For efficiency, consider: save images to processor storage + store content hash references
- **Recommendation**: Start with inline data URLs for simplicity, optimize later if DB size is a concern

### 2. AI SDK Message Flow
- `sendMessage({ text, files }, { body: {...} })` sends files as `UIMessage.parts` with `type: 'file'`
- The AI SDK's `DefaultChatTransport` serializes the full message to JSON in the request body
- `convertToModelMessages()` converts `file` parts to provider-specific image content:
  - OpenAI: `{ type: 'image_url', image_url: { url: 'data:...' } }`
  - Anthropic: `{ type: 'image', source: { type: 'base64', media_type: '...', data: '...' } }`
  - Google: `{ inlineData: { mimeType: '...', data: '...' } }`
- No custom provider handling needed - the AI SDK abstracts this

### 3. Conversation History with Images
- When loading conversation history from DB, image parts must be reconstructed
- These reconstructed messages go through `convertToModelMessages()` again
- Each message in history with images adds to the token context
- Consider: Only include image parts from the last N messages to avoid context overflow
- **Recommendation**: Include images from last 3 user messages, strip from older ones

### 4. Security
- Validate magic bytes server-side (existing `validateImageAttachment`)
- Sanitize filenames
- Limit image count per message (5)
- Limit total image size per message (10MB)
- Limit image size per file (4MB after base64)
- Don't serve user-uploaded data URLs directly to other users (XSS risk) - render via `<img>` with proper CSP

### 5. Non-Vision Model Behavior
- UI shows attachment button only when model supports vision
- Server rejects messages with images when model lacks vision
- Suggest vision-capable alternatives in error response
- If user switches model after attaching images, warn them

---

## Testing Strategy

### Unit Tests
- Image resize utility (canvas mock)
- Image validation with various file types and malformed data
- Message utils: save/load round-trip with file parts
- useGroupedParts with mixed text and file parts

### Integration Tests
- Full send flow: attach image → send → receive → verify API receives file parts
- Database round-trip: save message with images → load → verify images intact
- Vision capability gating: send image to non-vision model → verify rejection

### Manual Testing Checklist
- [ ] Paste image from clipboard → appears as attachment
- [ ] Drag-drop image from desktop → appears as attachment
- [ ] File picker → select multiple images → all appear
- [ ] Remove individual attachment
- [ ] Send message with text + image → model responds about the image
- [ ] Send message with only image (no text) → model describes the image
- [ ] View sent image in message history
- [ ] Reload page → image visible in conversation history
- [ ] Switch to non-vision model → attachment button hidden/disabled
- [ ] Send oversized image → client resizes before sending
- [ ] Send non-image file → rejected or handled gracefully

---

## Recommended Implementation Order

1. **useImageAttachments hook + image-resize utility** (foundation, testable independently)
2. **ChatInput/ChatTextarea attachment support** (UI layer - paste, drop, picker, preview)
3. **AiChatView integration** (wire up attachments to sendMessage)
4. **message-types.ts + useGroupedParts** (type system updates)
5. **MessageRenderer + ImageMessageContent** (display images in messages)
6. **message-utils.ts** (database persistence for file parts)
7. **chat/route.ts** (server validation, vision gating, save user message with files)
8. **Global assistant support** (apply same patterns)
9. **Testing + polish**

---

## Out of Scope (Phase 2: AI Reading Drive Images via Tools)

The following requires separate planning and involves reworking the tool calling system:
- `read_file_image` tool that returns image content to the AI
- Tool result rendering for images
- AI describing images stored in the drive
- Multi-modal tool results (images + text)
- Image search across drive files
