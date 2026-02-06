# Vision Support Implementation Plan

## Overview

Enable vision-capable AI models in PageSpace to receive and process images directly in chat messages. Users should be able to attach images (via paste, drag-drop, or file picker) to their chat input, and have those images sent to vision models alongside their text prompt.

This plan covers **Phase 1: Direct Image Upload to Chat** (images attached to user messages). Phase 2 (AI reading images from the drive via tool calling) is deferred as a separate effort.

**Applies to all three AI surfaces:**
1. **AI Chat Pages** (AiChatView) — dedicated chat pages with history/settings tabs
2. **Global Assistant** (GlobalAssistantView + SidebarChatTab) — workspace-level assistant in middle panel and right sidebar
3. **Page Agents** (SidebarChatTab agent mode) — page-level agents in the right sidebar

All three use the same `ChatInput` component, so changes to `ChatInput` propagate to all surfaces automatically.

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
   - **NOT currently used by the AI chat** — only exists as a reusable UI primitive

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

## Input Layout Design

### The Problem

The ChatInput footer is already crowded with two groups:

```
┌────────────────────────────────────────────────────┐
│  [Textarea ................................] [Send] │
│                                                    │
│  [🔧 Tools]            [Provider / Model] [🎙] [🎤]│
└────────────────────────────────────────────────────┘
```

**Left**: Tools popover (wrench icon + "Tools" label + badge)
**Right**: Provider/Model selector + Voice mode + Mic — already tight, text truncated at 50-100px

Adding another button to the footer would make it worse, especially on mobile and in the sidebar variant where `hideModelSelector` is already needed.

### The Solution: Paperclip in the Textarea Row

Place the attachment button **in the textarea row**, to the left of the textarea. This is the pattern used by ChatGPT, Claude, and most modern AI chat interfaces. It avoids touching the footer entirely.

```
┌────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────┐              │
│  │ [img1.jpg ✕] [photo.png ✕]      │  (previews)  │
│  └──────────────────────────────────┘              │
│  [📎] [Textarea ....................] [Send]        │
│                                                    │
│  [🔧 Tools]            [Provider / Model] [🎙] [🎤]│
└────────────────────────────────────────────────────┘
```

**Key design decisions:**

1. **Paperclip button** (`Paperclip` icon from lucide) — left of textarea, same height as send button (h-9 w-9), vertically aligned to bottom (`self-end`) to match send button
2. **Attachment preview strip** — appears ABOVE the textarea row when images are attached, inside the same flex-col container. Horizontal scrollable row of compact thumbnails (h-16) with ✕ remove buttons
3. **Button visibility** — always visible when model has vision. Muted/disabled with tooltip when model lacks vision. Hidden entirely for models that definitely can't use images (saves space)
4. **No footer changes** — the footer remains untouched

**Why this works for all three surfaces:**
- **AI Chat Pages** (variant="main"): Full space, paperclip fits naturally in the `flex items-start gap-2 p-3` row
- **Global Assistant** (variant="main"): Same layout as AI Chat Pages
- **Sidebar** (variant="sidebar"): Narrower but the paperclip is only 36px wide, and thumbnails scroll horizontally. Provider selector is already moved above the input in sidebar, so there's room

**Current textarea row layout** (`ChatInput.tsx` line 180):
```tsx
<div className="flex items-start gap-2 p-3 min-w-0">
  <ChatTextarea ... />
  <InputActions ... />
</div>
```

**New textarea row layout:**
```tsx
<div className="flex flex-col min-w-0">
  {/* Attachment preview strip (conditional) */}
  {attachments.length > 0 && (
    <AttachmentPreviewStrip attachments={attachments} onRemove={onRemove} />
  )}
  {/* Input row */}
  <div className="flex items-start gap-2 p-3 min-w-0">
    {hasVision && (
      <AttachButton onClick={openFilePicker} disabled={isStreaming} />
    )}
    <ChatTextarea ... />
    <InputActions ... />
  </div>
</div>
```

### Attachment Preview Strip Design

```
┌─────────────────────────────────────────────────────┐
│ [🖼 img.jpg ✕] [🖼 photo.png ✕] [🖼 screen... ✕]  │  ← horizontal scroll
└─────────────────────────────────────────────────────┘
```

- Compact pills: 32px tall, thumbnail (20x20) + filename (truncated) + ✕ button
- Horizontal flex with `overflow-x-auto` and `gap-2`
- Padding: `px-3 pt-2` (aligns with textarea row padding)
- Reuse the existing `PromptInputAttachment` visual pattern (hover card with large preview)
- Max visible: ~4-5 on desktop, scrollable on mobile/sidebar

### Paste and Drop Behavior

- **Clipboard paste**: ChatTextarea's `onPaste` intercepts image items from clipboard → adds to attachments
- **Drag-and-drop**: The outer flex-col container handles dragover/drop events → adds to attachments
- **File picker**: Paperclip button opens hidden `<input type="file" accept="image/*" multiple>`

### Interaction with @Mentions

The mention system uses an overlay in the ChatTextarea. The paperclip button is OUTSIDE the textarea (in the flex row), so there's no conflict. Paste handling checks for `item.kind === 'file'` first — if files are found, it handles them and `preventDefault()`; otherwise, normal text paste proceeds (including @mention text).

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

### Layer 1: Shared Foundation

**New files:**
- `apps/web/src/lib/ai/shared/hooks/useImageAttachments.ts`
- `apps/web/src/lib/ai/shared/utils/image-resize.ts`

#### 1.1 Client-side image resize utility
- Canvas-based resize: max 2048px on longest edge
- Maintains aspect ratio
- Outputs as JPEG data URL (q85) for photos, PNG for screenshots with transparency
- Returns `{ dataUrl, width, height, originalSize, resizedSize }`
- Used before blob→dataURL conversion to keep payloads small

#### 1.2 `useImageAttachments` hook
- Manages `attachedFiles: (FileUIPart & { id: string })[]` state
- `addFiles(files: File[])` — validates type (image/*), creates blob URLs, auto-resizes
- `removeFile(id: string)` — revokes blob URL, removes from array
- `clearFiles()` — revokes all blob URLs, empties array
- `convertForSend()` — converts blob URLs → data URLs (async), returns `FileUIPart[]`
- Cleanup on unmount (revoke blob URLs)
- Shared across all three AI surfaces via the hook

---

### Layer 2: ChatInput Attachment Support

**Files to modify:**
- `apps/web/src/components/ai/chat/input/ChatInput.tsx`
- `apps/web/src/components/ai/chat/input/ChatTextarea.tsx`

**New files:**
- `apps/web/src/components/ai/chat/input/AttachButton.tsx`
- `apps/web/src/components/ai/chat/input/AttachmentPreviewStrip.tsx`

#### 2.1 ChatInput changes
New props added to `ChatInputProps`:
```typescript
/** Image attachments */
attachments?: (FileUIPart & { id: string })[];
/** Add files handler */
onAddFiles?: (files: File[]) => void;
/** Remove file handler */
onRemoveFile?: (id: string) => void;
/** Whether the current model supports vision */
hasVision?: boolean;
```

Layout changes:
- Wrap existing content in outer flex-col
- Add `AttachmentPreviewStrip` above the input row (conditional on `attachments?.length > 0`)
- Add `AttachButton` before `ChatTextarea` in the input row (conditional on `hasVision`)
- Add hidden `<input type="file" accept="image/*" multiple>` triggered by AttachButton
- Add dragover/drop handlers on the outer container
- Update `canSend` logic: allow send when attachments exist even without text

#### 2.2 ChatTextarea changes
- Add `onPasteFiles?: (files: File[]) => void` prop
- In `onKeyDown` / textarea event handling, add `onPaste` handler:
  - Check `clipboardData.items` for `kind === 'file'`
  - If image files found, call `onPasteFiles(files)` and `preventDefault()`
  - Otherwise, let normal paste (including @mention text) proceed

#### 2.3 AttachButton component
- Simple icon button: `Paperclip` icon, h-9 w-9, `self-end` alignment
- Muted foreground color, hover effect
- Triggers hidden file input on click
- Tooltip: "Attach images"

#### 2.4 AttachmentPreviewStrip component
- Horizontal flex row with `overflow-x-auto gap-2 px-3 pt-2`
- Each attachment: compact pill (h-8) with image thumbnail (20x20) + filename (truncated) + ✕ button
- Hover card shows larger preview (reuse `PromptInputAttachment` visual pattern)
- Smooth enter/exit animation (framer-motion)

---

### Layer 3: Wire Up All Three AI Surfaces

Since all three surfaces use `ChatInput`, the component changes in Layer 2 propagate automatically. Each surface just needs to:
1. Create the `useImageAttachments` hook instance
2. Pass attachment state + handlers to `ChatInput`
3. Include files in the `sendMessage` call
4. Determine `hasVision` from the current model

#### 3.1 AI Chat Pages (AiChatView)

**File:** `apps/web/src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx`

```typescript
// Add hook
const { attachments, addFiles, removeFile, clearFiles, convertForSend } = useImageAttachments();

// Determine vision capability
const hasVision = hasVisionCapability(selectedModel || 'unknown');

// Update sendMessageWithContext
const sendMessageWithContext = useCallback(async (text: string) => {
  const files = await convertForSend(); // blob → data URLs
  const pageContext = await buildFreshPageContext();
  sendMessage(
    { text: trimmed, files },  // ← files added here
    { body: { chatId, conversationId, selectedProvider, selectedModel, pageContext, ... } }
  );
  clearFiles(); // clear after send
}, [...]);

// Pass to ChatInput
<ChatInput
  ...existing props
  attachments={attachments}
  onAddFiles={addFiles}
  onRemoveFile={removeFile}
  hasVision={hasVision}
/>
```

#### 3.2 Global Assistant (GlobalAssistantView)

**File:** `apps/web/src/components/layout/middle-content/page-views/dashboard/GlobalAssistantView.tsx`

Same pattern as 3.1. The GlobalAssistantView renders `ChatInput` via `ChatLayout`'s `renderInput` callback — the attachment props flow through the same way.

#### 3.3 Sidebar Chat (SidebarChatTab)

**File:** `apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarChatTab.tsx`

Same pattern. The sidebar uses `ChatInput` with `variant="sidebar"` and `hideModelSelector={true}`. The paperclip button and preview strip work within the narrower sidebar width because:
- Paperclip is only 36px wide
- Preview strip scrolls horizontally
- The sidebar already has `ProviderModelSelector` rendered separately above the input

The sidebar gets `currentModel` from `useAssistantSettingsStore` or page agent settings, so `hasVision` is derived from whichever model is active.

#### 3.4 `handleSendMessage` updates across surfaces

All three surfaces have a `handleSendMessage` callback. Each needs:
1. Call `convertForSend()` to get data URLs
2. Pass files to `sendMessage({ text, files }, ...)`
3. Call `clearFiles()` after send
4. Allow sending with images-only (no text) — update the `if (!input.trim()) return` guard

---

### Layer 4: Backend — API Route Handling

**Files to modify:**
- `apps/web/src/app/api/ai/chat/route.ts`
- `apps/web/src/app/api/ai/global/[id]/messages/route.ts`

Both routes follow the same pattern. Changes apply to both.

#### 4.1 Extract and validate image parts from user message
- When extracting the user message (`messages[messages.length - 1]`), detect `file` parts
- For each `file` part with `image/*` mediaType:
  - Validate using `validateImageAttachment()` (magic bytes check)
  - Enforce size limit (4MB per image, 10MB total per message)
  - Enforce count limit (max 5 images per message)
- Reject invalid images with descriptive error

#### 4.2 Check model vision capability before streaming
- After resolving the model, check `hasVisionCapability(currentModel)`
- If user message contains images but model lacks vision:
  - Return 400 error: "The selected model does not support image inputs"
  - Include `suggestedModels` from `getSuggestedVisionModels()`

#### 4.3 Ensure file parts flow through to AI model
- The key insight: `convertToModelMessages()` already handles `file` parts
- The conversation history loaded from DB must include file parts (see Layer 5)
- The last user message from the client already includes file parts via `UIMessage.parts`
- Verify `sanitizeMessagesForModel()` preserves `file` parts (it currently filters tool parts only)

---

### Layer 5: Database Persistence

**Files to modify:**
- `apps/web/src/lib/ai/core/message-utils.ts`
- `apps/web/src/app/api/ai/chat/route.ts` (user message save section)
- `apps/web/src/app/api/ai/global/[id]/messages/route.ts` (user message save section)

#### 5.1 Save image references in user messages
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

#### 5.2 Reconstruct file parts when loading conversation history
- Update `convertDbMessageToUIMessage()` to reconstruct `file` parts
- When a `partsOrder` entry has `type: 'file'`:
  - Look up corresponding entry in `fileParts`
  - Create `FileUIPart` with the stored data URL or resolve from content hash
- Ensure reconstructed messages include file parts so `convertToModelMessages()` includes them

#### 5.3 Handle user message save in chat route
- Currently saves only `extractMessageContent(userMessage)` (text only)
- Update to also save the full UIMessage with file parts
- Use the same structured content approach as assistant messages

---

### Layer 6: Message Rendering

**Files to modify:**
- `apps/web/src/components/ai/shared/chat/MessageRenderer.tsx`
- `apps/web/src/components/ai/shared/chat/message-types.ts`
- `apps/web/src/components/ai/shared/chat/useGroupedParts.ts`
- `apps/web/src/components/ai/shared/CompactMessageRenderer.tsx` (sidebar variant)

**New files:**
- `apps/web/src/components/ai/shared/chat/ImageMessageContent.tsx`

#### 6.1 Add FilePart type to message types
```typescript
interface FilePart {
  type: 'file';
  url: string;
  mediaType?: string;
  filename?: string;
}
```
- Update `GroupedPart` union type to include file parts
- Update type guards: `isFileGroupPart()`

#### 6.2 Update useGroupedParts to handle file parts
- File parts should NOT be grouped with text parts
- Adjacent `file` parts CAN be grouped together (image gallery within message)
- Maintain chronological order with text parts

#### 6.3 ImageMessageContent component
- Renders a group of image attachments in a message bubble
- Grid layout: 1 image → full width, 2 → side by side, 3+ → 2-column grid
- Thumbnail size: max 200px wide, aspect ratio preserved
- Click to expand (dialog/lightbox with full resolution)
- Handles loading state (skeleton) and error state (broken image icon)
- Works in both full MessageRenderer and CompactMessageRenderer

#### 6.4 Update TextBlock / MessageRenderer
- When a user message contains both text and images, render images above or below text
- User message bubble: images + text in natural order per `partsOrder`
- CompactMessageRenderer (sidebar): smaller thumbnails, max 1-2 visible with "+N" overflow

---

## File-by-File Change Summary

| File | Change | Description |
|------|--------|-------------|
| `apps/web/src/lib/ai/shared/hooks/useImageAttachments.ts` | **New** | Shared hook: attachment state, add/remove/clear, resize, blob→dataURL |
| `apps/web/src/lib/ai/shared/utils/image-resize.ts` | **New** | Canvas-based image resize utility (max 2048px) |
| `apps/web/src/components/ai/chat/input/AttachButton.tsx` | **New** | Paperclip icon button for file picker |
| `apps/web/src/components/ai/chat/input/AttachmentPreviewStrip.tsx` | **New** | Horizontal strip of attachment thumbnails with remove |
| `apps/web/src/components/ai/shared/chat/ImageMessageContent.tsx` | **New** | Image grid rendering for chat messages |
| `apps/web/src/components/ai/chat/input/ChatInput.tsx` | **Modify** | Add attach button + preview strip to textarea row, new props |
| `apps/web/src/components/ai/chat/input/ChatTextarea.tsx` | **Modify** | Add `onPasteFiles` prop and paste handler |
| `apps/web/src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx` | **Modify** | Hook up useImageAttachments, pass files to sendMessage |
| `apps/web/src/components/layout/middle-content/page-views/dashboard/GlobalAssistantView.tsx` | **Modify** | Hook up useImageAttachments, pass files to sendMessage |
| `apps/web/src/components/layout/right-sidebar/ai-assistant/SidebarChatTab.tsx` | **Modify** | Hook up useImageAttachments, pass files to sendMessage |
| `apps/web/src/app/api/ai/chat/route.ts` | **Modify** | Validate image parts, vision gate, save user message with files |
| `apps/web/src/app/api/ai/global/[id]/messages/route.ts` | **Modify** | Same image handling as page chat route |
| `apps/web/src/lib/ai/core/message-utils.ts` | **Modify** | Save/load file parts in structured content |
| `apps/web/src/components/ai/shared/chat/message-types.ts` | **Modify** | Add FilePart type, update GroupedPart union |
| `apps/web/src/components/ai/shared/chat/useGroupedParts.ts` | **Modify** | Handle file parts in grouping logic |
| `apps/web/src/components/ai/shared/chat/MessageRenderer.tsx` | **Modify** | Render image parts in messages |
| `apps/web/src/components/ai/shared/CompactMessageRenderer.tsx` | **Modify** | Render image parts in sidebar compact messages |
| `apps/web/src/lib/validation/image-validation.ts` | **Modify** | Add size limit constants, add `validateImageForAI()` |

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
- No custom provider handling needed — the AI SDK abstracts this

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
- Don't serve user-uploaded data URLs directly to other users (XSS risk) — render via `<img>` with proper CSP

### 5. Non-Vision Model Behavior
- UI shows attachment button only when model supports vision
- Server rejects messages with images when model lacks vision
- Suggest vision-capable alternatives in error response
- If user switches model after attaching images, warn them

### 6. Request Payload Size
- Next.js has a default body size limit (usually 1MB)
- With images, requests can be 5-20MB
- Need to increase the body size limit in the chat API route
- Add `export const config = { api: { bodyParser: { sizeLimit: '20mb' } } }` or equivalent Next.js 15 route segment config

---

## Testing Strategy

### Unit Tests
- Image resize utility (canvas mock)
- Image validation with various file types and malformed data
- Message utils: save/load round-trip with file parts
- useGroupedParts with mixed text and file parts
- useImageAttachments hook behavior

### Integration Tests
- Full send flow: attach image → send → verify API receives file parts
- Database round-trip: save message with images → load → verify images intact
- Vision capability gating: send image to non-vision model → verify rejection

### Manual Testing Checklist
- [ ] Paste image from clipboard → appears as attachment (all 3 surfaces)
- [ ] Drag-drop image from desktop → appears as attachment
- [ ] File picker → select multiple images → all appear
- [ ] Remove individual attachment
- [ ] Send message with text + image → model responds about the image
- [ ] Send message with only image (no text) → model describes the image
- [ ] View sent image in message history
- [ ] Reload page → image visible in conversation history
- [ ] Switch to non-vision model → attachment button hidden
- [ ] Send oversized image → client resizes before sending
- [ ] Send non-image file → rejected with error
- [ ] Sidebar layout → images don't overflow, scroll works
- [ ] AI Chat Page → images render in message bubbles
- [ ] Global Assistant (middle panel) → vision works
- [ ] Global Assistant (sidebar) → vision works in compact view
- [ ] Page Agent (sidebar) → vision works with agent's model

---

## Recommended Implementation Order

1. **`useImageAttachments` hook + `image-resize` utility** — foundation, testable independently
2. **`AttachButton` + `AttachmentPreviewStrip`** — new components, visual-only
3. **`ChatInput` + `ChatTextarea` modifications** — integrate attach button, paste, preview into shared input
4. **`AiChatView` integration** — wire up hook + sendMessage for AI Chat Pages
5. **`GlobalAssistantView` + `SidebarChatTab` integration** — wire up for global assistant + page agents
6. **`message-types.ts` + `useGroupedParts`** — type system updates for file parts
7. **`ImageMessageContent` + `MessageRenderer` + `CompactMessageRenderer`** — display images in messages
8. **`message-utils.ts`** — database persistence for file parts
9. **`chat/route.ts` + `global/[id]/messages/route.ts`** — server validation, vision gating, save with files
10. **Testing + polish**

---

## Out of Scope (Phase 2: AI Reading Drive Images via Tools)

The following requires separate planning and involves reworking the tool calling system:
- `read_file_image` tool that returns image content to the AI
- Tool result rendering for images
- AI describing images stored in the drive
- Multi-modal tool results (images + text)
- Image search across drive files
