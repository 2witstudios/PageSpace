# Visual Content Injection Plan

## Problem Statement
The AI cannot "see" images that are returned from tool responses because:
- Tools can only return JSON data
- Images must be part of message `parts` array to be processed by vision models
- Current `read_page` tool returns image data that the AI SDK doesn't know how to handle

## Core Insight
Tools can execute internal logic that programmatically sends messages to the conversation. Instead of returning image data, the tool can inject the image as a new message part, making it visible to the AI model.

## Proposed Solution: Tool-Triggered Image Injection

### Overview
When `read_page` encounters a visual file:
1. Load the image data from filesystem
2. Programmatically inject it into the message stream
3. Return success confirmation to the AI
4. AI continues processing with the image now in context

### Implementation Approaches

#### Approach A: Tool Returns Image for Stream Injection
```javascript
// Tool returns special response type
return {
  success: true,
  type: 'inject_image_message',
  imageData: {
    type: 'image',
    mimeType: 'image/png',
    data: `data:image/png;base64,${base64String}`
  },
  title: page.title,
  message: 'Image loaded and added to conversation'
};
```

The streaming handler detects `inject_image_message` type and adds the image to the message stream before continuing.

#### Approach B: Tool Has Direct Message Stream Access
```javascript
// Tool context includes injection callback
experimental_context: {
  userId,
  modelCapabilities,
  injectMessage: async (messagePart) => {
    // Add to message stream
  }
}

// Tool uses callback
if (visualContent && context.injectMessage) {
  await context.injectMessage({
    type: 'image',
    image: dataUrl
  });
  
  return {
    success: true,
    message: "Image loaded. Analyzing..."
  };
}
```

### Technical Implementation

#### 1. Update Tool Execution Context
**File:** `/apps/web/src/lib/ai/types.ts`
```typescript
export interface ToolExecutionContext {
  userId: string;
  conversationId?: string;
  locationContext?: {...};
  modelCapabilities?: ModelCapabilities;
  // Add message injection capability
  injectMessage?: (part: MessagePart) => Promise<void>;
}
```

#### 2. Modify Route Handler
**File:** `/apps/web/src/app/api/ai_conversations/[id]/messages/route.ts`
```javascript
// Create injection function
const injectMessage = async (messagePart) => {
  // Logic to add part to current message stream
  // This needs to integrate with AI SDK's streaming
};

// Pass in context
experimental_context: {
  userId,
  locationContext,
  modelCapabilities: getModelCapabilities(currentModel, currentProvider),
  injectMessage
}
```

#### 3. Update read_page Tool
**File:** `/apps/web/src/lib/ai/tools/page-read-tools.ts`
```javascript
case 'visual':
  const modelCapabilities = context?.modelCapabilities;
  
  if (!modelCapabilities?.hasVision) {
    return {
      success: true,
      type: 'visual_requires_vision_model',
      message: 'Switch to a vision-capable model to view this image'
    };
  }
  
  // Load visual content
  if (page.filePath) {
    const visualResult = await loadVisualContent(page.filePath, page.mimeType);
    
    if (visualResult.success && context.injectMessage) {
      // Inject image into conversation
      await context.injectMessage({
        type: 'image',
        mimeType: visualResult.visualContent.mimeType,
        image: `data:${visualResult.visualContent.mimeType};base64,${visualResult.visualContent.base64}`
      });
      
      return {
        success: true,
        title: page.title,
        message: `Loaded ${page.title}. I can now see the image.`
      };
    }
  }
```

### Alternative: Return Data URL Directly
If injection proves complex, a simpler approach:

```javascript
// Tool returns data URL
return {
  success: true,
  type: 'visual_content',
  title: page.title,
  imageDataUrl: `data:${mimeType};base64,${base64}`,
  message: "Image loaded for viewing"
};
```

Frontend can detect and render this, though AI won't directly "see" it in the current turn.

## Implementation Steps

1. **Research Phase**
   - Investigate how AI SDK handles message stream modification
   - Check if tools can access/modify the message stream
   - Look for existing patterns in the codebase

2. **Prototype Phase**
   - Implement simplest approach first (return data URL)
   - Test with Gemini 2.5 Flash to verify it works
   - Measure performance with different image sizes

3. **Full Implementation**
   - Add message injection capability to tool context
   - Update read_page tool to use injection
   - Handle edge cases (large files, unsupported formats)
   - Add proper error handling

4. **Testing**
   - Test with various vision models (GPT-4o, Gemini, Claude)
   - Verify images are properly visible to AI
   - Ensure no regression in non-visual file handling

## Benefits

- **Seamless Experience**: AI can analyze stored images as if user uploaded them
- **No Frontend Changes**: Works within existing tool infrastructure
- **Multi-Provider Support**: Works with any vision-capable model
- **Maintains Context**: Images become part of conversation history

## Challenges to Address

1. **Streaming Complexity**: Modifying message stream mid-execution
2. **Timing**: Ensuring image is injected before AI processes
3. **Size Limits**: Large images may exceed token limits
4. **Performance**: Base64 encoding overhead

## Success Criteria

- [ ] AI can "see" images loaded by read_page tool
- [ ] No hanging/stuck behavior with Gemini or other models
- [ ] Works with all vision-capable providers
- [ ] Clear error messages for non-vision models
- [ ] Performance acceptable for images up to 10MB

## Next Steps

1. Verify AI SDK's message stream modification capabilities
2. Implement data URL return as MVP
3. Add full injection support if needed
4. Test across all supported vision models