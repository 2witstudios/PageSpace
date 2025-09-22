# Model Capabilities Detection System

## Overview

PageSpace automatically detects and adapts to AI model capabilities, ensuring optimal feature availability and graceful degradation. The system identifies vision support, tool calling abilities, and other model-specific features to provide the best user experience across 100+ supported models.

## Architecture

### Capability Detection Framework

```typescript
interface ModelCapabilities {
  hasVision: boolean;
  hasTools: boolean;
  model: string;
  provider: string;
}

// Automatic capability detection for every AI interaction
const capabilities = await getModelCapabilities(selectedModel, selectedProvider);
```

### Multi-Layer Detection System

1. **Static Capability Maps**: Known capabilities for specific models
2. **Pattern-Based Detection**: Intelligent name-based inference
3. **Runtime API Validation**: Live capability checking via provider APIs
4. **Caching Layer**: Performance-optimized capability storage

---

## Vision Capability Detection

### Known Vision Models

PageSpace maintains a comprehensive database of vision-capable models:

```typescript
const VISION_CAPABLE_MODELS: Record<string, boolean> = {
  // OpenAI GPT-5 Models (all have vision)
  'gpt-5': true,
  'gpt-5-mini': true,
  'gpt-5-2025-08-07': true,

  // GPT-4o Family (omni models)
  'gpt-4o': true,
  'gpt-4o-mini': true,
  'gpt-4o-audio-preview': true,
  'gpt-4-turbo': true,
  'gpt-4-vision-preview': true,

  // Anthropic Claude 3+ (all have vision)
  'claude-opus-4-1-20250805': true,
  'claude-3-5-sonnet-20241022': true,
  'claude-3-5-haiku-20241022': true,
  'claude-3-opus-20240229': true,

  // Google Gemini (all versions support vision)
  'gemini-2.5-pro': true,
  'gemini-2.5-flash': true,
  'gemini-2.0-flash-exp': true,
  'gemini-1.5-pro': true,

  // xAI Grok Vision Models
  'grok-2-vision': true,
  'grok-vision-beta': true,

  // Special handling for o1 models - NO vision support
  'o1': false,
  'o1-mini': false,
  'o1-preview': false,
  'o3': false,
  'o3-mini': false
};
```

### Intelligent Pattern Detection

When a model isn't in the static database, PageSpace uses pattern-based detection:

```typescript
export function hasVisionCapability(model: string): boolean {
  // Direct lookup first
  if (model in VISION_CAPABLE_MODELS) {
    return VISION_CAPABLE_MODELS[model];
  }

  const lowerModel = model.toLowerCase();

  // Explicit vision indicators
  if (lowerModel.includes('vision') || lowerModel.includes('-v-')) {
    return true;
  }

  // GPT-5 family (all have vision)
  if (lowerModel.includes('gpt-5')) {
    return true;
  }

  // GPT-4o family (omni models have vision)
  if (lowerModel.includes('gpt-4o')) {
    return true;
  }

  // Claude 3 and above have vision
  if (lowerModel.includes('claude-3') || lowerModel.includes('claude-4')) {
    return true;
  }

  // All Gemini models have vision
  if (lowerModel.includes('gemini')) {
    return true;
  }

  // Grok vision models
  if (lowerModel.includes('grok') && lowerModel.includes('vision')) {
    return true;
  }

  return false;
}
```

### Vision Feature Applications

When vision is detected, PageSpace enables:

- **Image Upload Support**: File upload interface shows image options
- **Visual Content Tools**: AI can process screenshots, diagrams, charts
- **Canvas Integration**: AI can analyze custom HTML/CSS layouts
- **Document Processing**: Enhanced PDF and document analysis

---

## Tool Capability Detection

### Provider-Specific Validation

Different providers require different validation approaches:

#### OpenRouter API Integration

For OpenRouter models, PageSpace queries their live API for authoritative capability data:

```typescript
interface OpenRouterModel {
  id: string;
  supported_parameters?: string[];
}

async function fetchOpenRouterToolCapabilities(): Promise<Map<string, boolean>> {
  const response = await fetch('https://openrouter.ai/api/v1/models');
  const data = await response.json();
  const models = data.data as OpenRouterModel[];

  const capabilities = new Map<string, boolean>();

  models.forEach(model => {
    const hasTools = model.supported_parameters?.includes('tools') &&
                    model.supported_parameters?.includes('tool_choice');
    capabilities.set(model.id, hasTools || false);
  });

  return capabilities;
}
```

**Benefits:**
- **Real-time accuracy**: Always current with provider capabilities
- **No maintenance required**: Automatic updates as providers add features
- **Comprehensive coverage**: 100+ models validated automatically

#### Static Override System

Known problematic models are handled via static overrides:

```typescript
const NON_TOOL_CAPABLE_MODELS: Record<string, boolean> = {
  // Gemma family generally lacks tool support
  'gemma:1b': false,
  'gemma:2b': false,
  'gemma:7b': false,
  'gemma2:2b': false,
  'gemma2:9b': false,
  'gemma3:1b': false,
  'gemma3:2b': false
};
```

### Caching Strategy

Tool capability detection includes intelligent caching:

```typescript
// Runtime cache for performance
const toolCapabilityCache = new Map<string, boolean>();
const openRouterModelsCache = new Map<string, boolean>();
let openRouterCacheExpiry = 0;

export async function hasToolCapability(model: string, provider: string): Promise<boolean> {
  const cacheKey = `${provider}:${model}`;

  // Check runtime cache first
  if (toolCapabilityCache.has(cacheKey)) {
    return toolCapabilityCache.get(cacheKey)!;
  }

  // Provider-specific validation
  if (provider === 'openrouter') {
    const capabilities = await fetchOpenRouterToolCapabilities();
    const hasTools = capabilities.get(model) || false;
    toolCapabilityCache.set(cacheKey, hasTools);
    return hasTools;
  }

  // Default behavior with caching
  const hasTools = !model.toLowerCase().includes('gemma');
  toolCapabilityCache.set(cacheKey, hasTools);
  return hasTools;
}
```

**Cache Strategy:**
- **1-hour TTL**: OpenRouter API data cached for 1 hour
- **Session persistence**: Runtime cache persists across requests
- **Graceful fallback**: Cache failures don't break functionality

---

## Capability-Aware Feature Adaptation

### Tool Interface Adaptation

Based on detected capabilities, PageSpace adapts the AI interface:

```typescript
// Tool availability checking in AI chat
const modelCapabilities = await getModelCapabilities(currentModel, currentProvider);

if (modelCapabilities.hasTools) {
  // Enable full tool suite
  const tools = ToolPermissionFilter.filterTools(pageSpaceTools, agentRole);

  const aiResult = streamText({
    model,
    tools, // Full tool integration
    stopWhen: stepCountIs(100) // Allow complex operations
  });
} else {
  // Tools-free conversation mode
  const aiResult = streamText({
    model,
    // No tools parameter - pure text conversation
  });
}
```

### Visual Content Processing

Vision capability detection enables advanced content processing:

```typescript
if (modelCapabilities.hasVision) {
  // Enable image upload and processing
  const visualContent = await loadVisualContent(page, provider);

  // Add visual content to message context
  const enhancedMessages = messages.map(msg => ({
    ...msg,
    experimental_attachments: visualContent
  }));
}
```

### Graceful Degradation

When capabilities are unavailable, PageSpace provides alternative approaches:

```typescript
// Fallback suggestions for tool-incapable models
export function getSuggestedToolCapableModels(provider: string): string[] {
  switch (provider) {
    case 'ollama':
      return ['llama3.1:8b', 'qwen2.5:7b', 'mistral:7b'];
    case 'openrouter':
      return ['meta-llama/llama-3.1-8b-instruct', 'qwen/qwen-2.5-7b-instruct'];
    case 'google':
      return ['gemini-2.5-flash', 'gemini-1.5-flash'];
    case 'openai':
      return ['gpt-4o-mini', 'gpt-3.5-turbo'];
    case 'anthropic':
      return ['claude-3-haiku', 'claude-3-5-sonnet'];
    default:
      return ['gpt-4o-mini', 'claude-3-haiku', 'gemini-2.5-flash'];
  }
}

// Vision capability fallbacks
export function getSuggestedVisionModels(): string[] {
  return [
    'gpt-4o-mini',        // Affordable OpenAI option
    'claude-3-haiku',     // Fast Anthropic option
    'gemini-2.5-flash',   // Google's fast option
  ];
}
```

---

## Implementation Integration

### Context Injection

Model capabilities are automatically injected into tool execution contexts:

```typescript
const result = await streamText({
  model,
  tools: filteredTools,
  experimental_context: {
    userId,
    modelCapabilities: await getModelCapabilities(currentModel, currentProvider)
  }
});
```

### UI Adaptation

The frontend adapts based on detected capabilities:

```typescript
// Component capability checking
const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilities>();

useEffect(() => {
  async function checkCapabilities() {
    const caps = await getModelCapabilities(selectedModel, selectedProvider);
    setModelCapabilities(caps);
  }
  checkCapabilities();
}, [selectedModel, selectedProvider]);

// Conditional feature rendering
{modelCapabilities?.hasVision && (
  <ImageUploadComponent />
)}

{modelCapabilities?.hasTools && (
  <ToolConfigurationPanel />
)}
```

### Error Handling

Capability mismatches are handled gracefully:

```typescript
// Tool execution with capability validation
try {
  if (!modelCapabilities.hasTools) {
    logger.warn('Tools requested for non-tool-capable model', {
      model: currentModel,
      provider: currentProvider
    });

    // Fall back to text-only mode
    return await generateTextWithoutTools();
  }

  return await generateTextWithTools();
} catch (error) {
  if (error.message.includes('tools not supported')) {
    // Runtime capability correction
    await updateModelCapabilities(currentModel, currentProvider, { hasTools: false });
    return await generateTextWithoutTools();
  }
  throw error;
}
```

---

## Performance Optimizations

### Lazy Loading

Capabilities are detected only when needed:

```typescript
// Capability detection triggered by usage
const capabilities = useMemo(async () => {
  if (selectedModel && selectedProvider) {
    return await getModelCapabilities(selectedModel, selectedProvider);
  }
  return null;
}, [selectedModel, selectedProvider]);
```

### Batch Detection

Multiple capability checks are batched for efficiency:

```typescript
// Batch capability detection for multiple models
export async function batchGetCapabilities(
  models: Array<{ model: string; provider: string }>
): Promise<ModelCapabilities[]> {
  return Promise.all(
    models.map(({ model, provider }) => getModelCapabilities(model, provider))
  );
}
```

### Background Updates

OpenRouter capabilities are updated in the background:

```typescript
// Background capability refresh
setInterval(async () => {
  try {
    await fetchOpenRouterToolCapabilities();
    logger.debug('Updated OpenRouter model capabilities');
  } catch (error) {
    logger.warn('Failed to update OpenRouter capabilities:', error);
  }
}, 60 * 60 * 1000); // Every hour
```

---

## Monitoring & Analytics

### Capability Usage Tracking

PageSpace tracks capability utilization for optimization:

```typescript
// Track capability feature usage
await trackFeature(userId, 'vision_model_used', {
  model: currentModel,
  provider: currentProvider,
  hasVision: modelCapabilities.hasVision
});

await trackFeature(userId, 'tools_executed', {
  model: currentModel,
  provider: currentProvider,
  hasTools: modelCapabilities.hasTools,
  toolCount: toolExecutionCount
});
```

### Capability Mismatches

Detection errors and mismatches are logged for improvement:

```typescript
// Log capability detection accuracy
if (expectedTools && !modelCapabilities.hasTools) {
  logger.warn('Tool capability mismatch detected', {
    model: currentModel,
    provider: currentProvider,
    expected: true,
    detected: false,
    source: 'user_report'
  });
}
```

### Performance Metrics

Capability detection performance is monitored:

```typescript
// Monitor detection performance
const startTime = performance.now();
const capabilities = await getModelCapabilities(model, provider);
const detectionTime = performance.now() - startTime;

await trackPerformance('capability_detection', {
  duration: detectionTime,
  model,
  provider,
  cacheHit: capabilities.fromCache
});
```

---

## Future Enhancements

### Planned Capabilities

Additional capability detection is planned for:

- **Audio Processing**: Voice input/output support
- **Code Execution**: Safe code execution environments
- **Multimodal Output**: Image/audio generation capabilities
- **Reasoning Modes**: Chain-of-thought, reflection, planning modes

### Enhanced Detection

Future improvements include:

- **Provider SDK Integration**: Direct capability queries from provider SDKs
- **Model Fingerprinting**: Behavioral capability detection
- **User Feedback Loop**: Community-driven capability verification
- **Predictive Capability**: AI-powered capability prediction for new models

---

## Developer Guidelines

### Adding New Capabilities

To add a new capability type:

1. **Extend Interface**: Add property to `ModelCapabilities`
2. **Create Detection Logic**: Implement detection function
3. **Update Static Maps**: Add known model capabilities
4. **Add Pattern Detection**: Implement name-based inference
5. **Integrate UI**: Add conditional feature rendering
6. **Update Documentation**: Document new capability

### Testing Capabilities

Test capability detection with:

```typescript
// Unit test example
describe('Model Capabilities', () => {
  test('detects GPT-4o vision capability', async () => {
    const capabilities = await getModelCapabilities('gpt-4o', 'openai');
    expect(capabilities.hasVision).toBe(true);
    expect(capabilities.hasTools).toBe(true);
  });

  test('detects Gemma tool limitations', async () => {
    const capabilities = await getModelCapabilities('gemma:7b', 'ollama');
    expect(capabilities.hasTools).toBe(false);
  });
});
```

### Performance Guidelines

Optimize capability detection by:

- **Caching results**: Avoid repeated API calls
- **Batch operations**: Group multiple checks
- **Lazy evaluation**: Check capabilities only when needed
- **Background updates**: Refresh capabilities periodically

This comprehensive capability detection system ensures PageSpace provides optimal AI experiences across the entire spectrum of available models while gracefully handling limitations and providing intelligent fallbacks.