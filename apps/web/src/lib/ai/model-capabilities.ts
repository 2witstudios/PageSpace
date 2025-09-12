/**
 * Model Capabilities Detection
 * Identifies which AI models support vision, audio, and other features
 */

/**
 * Map of models that support vision/multimodal capabilities
 * Includes models that can process images, PDFs with images, etc.
 */
const VISION_CAPABLE_MODELS: Record<string, boolean> = {
  // OpenAI GPT-5 Models (all have vision)
  'gpt-5': true,
  'gpt-5-mini': true,
  'gpt-5-nano': true,
  'gpt-5-2025-08-07': true,
  'gpt-5-chat-latest': true,
  'openai/gpt-5': true,
  'openai/gpt-5-mini': true,
  'openai/gpt-5-nano': true,
  
  // OpenAI GPT-4o Models with Vision
  'gpt-4o': true,
  'gpt-4o-mini': true,
  'gpt-4o-audio-preview': true,
  'gpt-4-turbo': true,
  'gpt-4-turbo-preview': true,
  'gpt-4-vision-preview': true,
  'gpt-4': true,
  'openai/gpt-4o': true,
  'openai/gpt-4o-mini': true,
  'openai/gpt-4-turbo': true,
  'openai/gpt-4': true,
  
  // Anthropic Claude 3+ (all have vision)
  'claude-opus-4-1-20250805': true,
  'claude-sonnet-4-1-20250805': true,
  'claude-3-7-sonnet-20250219': true,
  'claude-3-5-sonnet-20241022': true,
  'claude-3-5-sonnet-20240620': true,
  'claude-3-5-haiku-20241022': true,
  'claude-3-opus-20240229': true,
  'claude-3-sonnet-20240229': true,
  'claude-3-haiku-20240307': true,
  'anthropic/claude-3.5-sonnet': true,
  'anthropic/claude-3-haiku': true,
  'anthropic/claude-opus-4.1': true,
  
  // Google Gemini (all versions support vision)
  'gemini-2.5-pro': true,
  'gemini-2.5-flash': true,
  'gemini-2.5-flash-lite': true,
  'gemini-2.0-flash-exp': true,
  'gemini-1.5-pro': true,
  'gemini-1.5-flash': true,
  'google/gemini-2.5-pro': true,
  'google/gemini-2.5-flash': true,
  'google/gemini-2.5-flash-lite': true,
  'google/gemini-2.5-flash-lite-preview-06-17': true,
  
  // xAI Grok Vision models
  'grok-2-vision': true,
  'grok-2-vision-latest': true,
  'grok-2-vision-1212': true,
  'grok-vision-beta': true,
  'x-ai/grok-4': true, // Grok 4 likely has vision
  
  // Chinese/Asian Vision Models
  'z-ai/glm-4.5v': true, // 'v' suffix indicates vision
  
  // Special handling for o1 models - they DON'T support vision
  'o1': false,
  'o1-mini': false,
  'o1-preview': false,
  'o3': false,
  'o3-mini': false,
  'o4-mini': false,
};

/**
 * Check if a model has vision/multimodal capabilities
 * @param model - The model identifier
 * @returns true if the model supports vision
 */
export function hasVisionCapability(model: string): boolean {
  // Direct lookup first
  if (model in VISION_CAPABLE_MODELS) {
    return VISION_CAPABLE_MODELS[model];
  }
  
  // Check for vision-related keywords in model name
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
  
  // Default to false for unknown models
  return false;
}

/**
 * Get a list of suggested vision-capable models for fallback
 * @returns Array of model suggestions
 */
export function getSuggestedVisionModels(): string[] {
  return [
    'gpt-4o-mini',        // Affordable OpenAI option
    'claude-3-haiku',     // Fast Anthropic option
    'gemini-2.5-flash',   // Google's fast option
  ];
}

/**
 * Model capabilities interface
 */
export interface ModelCapabilities {
  hasVision: boolean;
  model: string;
  provider: string;
}

/**
 * Get full capabilities for a model
 * @param model - The model identifier
 * @param provider - The provider name
 * @returns Model capabilities object
 */
export function getModelCapabilities(model: string, provider: string): ModelCapabilities {
  return {
    hasVision: hasVisionCapability(model),
    model,
    provider,
  };
}