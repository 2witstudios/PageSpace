/**
 * Which backend serves a UI provider. Kept free of imports so client-safe
 * modules (vision-models.ts) can depend on it; ai-providers-config re-exports it.
 */

/**
 * Cloud vendor providers — every one is served through OpenRouter. The remainder
 * (Ollama, LM Studio, Azure OpenAI) keep their own backends for on-prem.
 */
const CLOUD_VENDOR_PROVIDERS = new Set<string>([
  'openai', 'anthropic', 'google', 'xai', 'deepseek', 'qwen', 'mistral',
  'moonshot', 'minimax', 'meta', 'bytedance', 'writer', 'zai',
  'aion-labs', 'amazon', 'cohere', 'ibm-granite',
  'inclusionai', 'liquid', 'nex-agi', 'nvidia',
  'rekaai', 'relace', 'sakana', 'sao10k', 'stepfun', 'tencent',
  'thedrummer', 'thinkingmachines', 'upstage', 'xiaomi',
]);

/**
 * Map a UI provider to its backend. Every cloud vendor routes through OpenRouter;
 * local providers use their own backend.
 */
export function getBackendProvider(uiProvider: string): string {
  if (CLOUD_VENDOR_PROVIDERS.has(uiProvider)) return 'openrouter';
  return uiProvider;
}

/**
 * Whether a provider's backend delivers a tool result's media (image-data /
 * file-data parts) to the model as media. Checked in the installed SDKs:
 * @openrouter/ai-sdk-provider maps them to image_url / file content, while
 * @ai-sdk/openai-compatible (glm, lmstudio, azure_openai) and ollama-ai-provider-v2
 * JSON.stringify the whole `content` output, so an image becomes megabytes of
 * base64 text. Tools that return media (read_page, browser_screenshot) and the
 * history guard both read this through getToolMediaCapabilities.
 */
export function supportsToolResultMedia(provider: string): boolean {
  return getBackendProvider(provider) === 'openrouter';
}
