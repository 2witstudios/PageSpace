//
//  AIProviders.swift
//  PageSpace
//
//  Provider and model configuration mirroring web app's ai-providers-config.ts
//

import Foundation

// MARK: - Provider Configuration

struct AIProvider {
    let name: String
    let models: [String: String] // [modelId: displayName]
}

/// All available AI providers with their models
/// Mirrors web app's AI_PROVIDERS from ai-providers-config.ts
let AI_PROVIDERS: [String: AIProvider] = [
    "pagespace": AIProvider(
        name: "PageSpace",
        models: [
            "glm-4.5-air": "Standard",
            "glm-4.6": "Pro (Pro/Business)"
        ]
    ),

    "openrouter": AIProvider(
        name: "OpenRouter (Paid)",
        models: [
            // Anthropic Models (2025)
            "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
            "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
            "anthropic/claude-3.5-sonnet": "Claude 3.5 Sonnet",
            "anthropic/claude-3.5-sonnet:beta": "Claude 3.5 Sonnet (Beta)",
            "anthropic/claude-3.5-haiku": "Claude 3.5 Haiku",
            "anthropic/claude-3-opus": "Claude 3 Opus",
            // OpenAI Models (2025)
            "openai/gpt-4o": "GPT-4o",
            "openai/gpt-4o-mini": "GPT-4o Mini",
            "openai/o3-deep-research": "o3 Deep Research",
            "openai/o4-mini-deep-research": "o4 Mini Deep Research",
            "openai/o1": "OpenAI o1",
            "openai/o1-mini": "OpenAI o1-mini",
            "openai/o1-preview": "OpenAI o1-preview",
            // Google Models
            "google/gemini-pro-1.5": "Gemini Pro 1.5",
            "google/gemini-flash-1.5": "Gemini Flash 1.5",
            // xAI Models (2025)
            "x-ai/grok-4-fast": "Grok 4 Fast (2M context)",
            "x-ai/grok-2-1212": "Grok 2 1212",
            "x-ai/grok-beta": "Grok Beta",
            "x-ai/grok-2-vision-1212": "Grok 2 Vision",
            // Meta Models
            "meta-llama/llama-3.3-70b-instruct": "Llama 3.3 70B",
            "meta-llama/llama-3.2-90b-vision-instruct": "Llama 3.2 90B Vision",
            // Qwen Models (2025)
            "qwen/qwen3-max": "Qwen3 Max",
            "qwen/qwen3-coder-plus": "Qwen3 Coder Plus",
            "qwen/qwen-2.5-coder-32b-instruct": "Qwen 2.5 Coder 32B",
            "qwen/qwq-32b-preview": "QwQ 32B Preview",
            // DeepSeek Models (2025)
            "deepseek/deepseek-v3.1-terminus": "DeepSeek V3.1 Terminus",
            "deepseek/deepseek-chat": "DeepSeek Chat",
            "deepseek/deepseek-r1": "DeepSeek R1",
            // Mistral Models
            "mistralai/mistral-large": "Mistral Large",
            "mistralai/mistral-small": "Mistral Small",
            // Other Models
            "cohere/command-r-plus": "Command R+",
            "perplexity/llama-3.1-sonar-large-128k-online": "Perplexity Sonar Large"
        ]
    ),

    "openrouter_free": AIProvider(
        name: "OpenRouter (Free)",
        models: [
            // Google Models
            "google/gemini-2.0-flash-exp:free": "Gemini 2.0 Flash",
            "google/gemini-exp-1206:free": "Gemini Exp 1206",
            "google/gemini-2.0-flash-thinking-exp:free": "Gemini 2.0 Flash Thinking",
            // Meta Models
            "meta-llama/llama-3.3-70b-instruct:free": "Llama 3.3 70B",
            "meta-llama/llama-3.2-90b-vision-instruct:free": "Llama 3.2 90B Vision",
            // Qwen Models
            "qwen/qwen-2.5-coder-32b-instruct:free": "Qwen 2.5 Coder 32B",
            "qwen/qwq-32b-preview:free": "QwQ 32B Preview",
            // DeepSeek Models (2025)
            "deepseek/deepseek-r1:free": "DeepSeek R1",
            "deepseek/deepseek-r1-distill-llama-70b:free": "DeepSeek R1 Distill Llama 70B",
            "deepseek/deepseek-r1-distill-qwen-32b:free": "DeepSeek R1 Distill Qwen 32B",
            // Other Models (2025)
            "minimax/minimax-m2:free": "MiniMax M2",
            "nvidia/nemotron-nano-12b-v2-vl:free": "Nemotron Nano 12B VL",
            "alibaba/tongyi-deepresearch-30b-a3b:free": "Tongyi DeepResearch 30B",
            "openrouter/polaris-alpha:free": "Polaris Alpha",
            "mistralai/mistral-7b-instruct:free": "Mistral 7B",
            "microsoft/phi-3.5-mini-128k-instruct:free": "Phi 3.5 Mini"
        ]
    ),

    "google": AIProvider(
        name: "Google AI",
        models: [
            // Gemini 2.5 Series (2025)
            "gemini-2.5-pro": "Gemini 2.5 Pro",
            "gemini-2.5-flash": "Gemini 2.5 Flash",
            "gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
            // Gemini 2.0 Series (2025)
            "gemini-2.0-pro-exp": "Gemini 2.0 Pro (Experimental)",
            "gemini-2.0-flash": "Gemini 2.0 Flash",
            "gemini-2.0-flash-lite": "Gemini 2.0 Flash-Lite"
        ]
    ),

    "openai": AIProvider(
        name: "OpenAI",
        models: [
            // GPT-5 Series (2025)
            "gpt-5": "GPT-5",
            "gpt-5-mini": "GPT-5 Mini",
            "gpt-5-nano": "GPT-5 Nano",
            // GPT-4.1 Series (2025)
            "gpt-4.1-2025-04-14": "GPT-4.1",
            "gpt-4.1-mini-2025-04-14": "GPT-4.1 Mini",
            "gpt-4.1-nano-2025-04-14": "GPT-4.1 Nano",
            // GPT-4o Series
            "gpt-4o": "GPT-4o",
            "gpt-4o-mini": "GPT-4o Mini",
            // Reasoning Models
            "o4-mini-2025-04-16": "o4-mini",
            "o3": "o3",
            "o3-mini": "o3-mini",
            "o1": "o1",
            "o1-mini": "o1-mini",
            "o1-preview": "o1-preview",
            // Legacy Models
            "gpt-4-turbo": "GPT-4 Turbo",
            "gpt-4": "GPT-4",
            "gpt-3.5-turbo": "GPT-3.5 Turbo"
        ]
    ),

    "anthropic": AIProvider(
        name: "Anthropic",
        models: [
            // Claude 4.5 Series (2025)
            "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
            "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
            // Claude 4.1 Series (2025)
            "claude-opus-4-1-20250805": "Claude Opus 4.1",
            "claude-sonnet-4-1-20250805": "Claude Sonnet 4.1",
            // Claude 4 Series
            "claude-sonnet-4-20250514": "Claude Sonnet 4",
            // Claude 3.7 Series
            "claude-3-7-sonnet-20250219": "Claude 3.7 Sonnet",
            // Claude 3.5 Series
            "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet (Oct)",
            "claude-3-5-sonnet-20240620": "Claude 3.5 Sonnet (June)",
            "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
            // Claude 3 Series
            "claude-3-opus-20240229": "Claude 3 Opus",
            "claude-3-sonnet-20240229": "Claude 3 Sonnet",
            "claude-3-haiku-20240307": "Claude 3 Haiku"
        ]
    ),

    "xai": AIProvider(
        name: "xAI",
        models: [
            // Grok 4 Series (2025)
            "grok-4": "Grok 4",
            "grok-4-fast-reasoning": "Grok 4 Fast (Reasoning)",
            "grok-4-fast-non-reasoning": "Grok 4 Fast (Non-Reasoning)",
            "grok-code-fast-1": "Grok Code Fast 1",
            // Grok 3 Series
            "grok-3": "Grok 3",
            "grok-3-fast": "Grok 3 Fast",
            "grok-3-mini": "Grok 3 Mini",
            "grok-3-mini-fast": "Grok 3 Mini Fast",
            // Grok 2 Series
            "grok-2": "Grok 2",
            "grok-2-1212": "Grok 2 1212",
            "grok-2-vision": "Grok 2 Vision",
            "grok-2-vision-1212": "Grok 2 Vision 1212",
            // Beta
            "grok-beta": "Grok Beta"
        ]
    ),

    "ollama": AIProvider(
        name: "Ollama",
        models: [:] // Dynamic models loaded from API
    ),

    "lmstudio": AIProvider(
        name: "LM Studio",
        models: [:] // Dynamic models loaded from API
    ),

    "glm": AIProvider(
        name: "GLM Coder Plan",
        models: [
            "glm-4-plus": "GLM-4 Plus",
            "glm-4-flash": "GLM-4 Flash",
            "glm-4-long": "GLM-4 Long",
            "glm-4-air": "GLM-4 Air",
            "glm-4-airx": "GLM-4 AirX"
        ]
    )
]

// MARK: - Helper Functions

/// Maps UI provider names to backend provider names
/// Mirrors web app's getBackendProvider() function
func getBackendProvider(_ uiProvider: String) -> String {
    switch uiProvider {
    case "pagespace":
        return "glm"
    case "openrouter_free":
        return "openrouter"
    case "glm":
        return "openai"
    default:
        return uiProvider
    }
}

/// Gets the default model for a given provider
/// Updated November 2025 with latest flagship models
func getDefaultModel(for provider: String) -> String {
    switch provider {
    case "pagespace":
        return "glm-4.5-air"
    case "openrouter":
        return "anthropic/claude-sonnet-4.5"
    case "openrouter_free":
        return "google/gemini-2.0-flash-exp:free"
    case "google":
        return "gemini-2.5-flash" // Updated to 2.5 Flash (2025)
    case "openai":
        return "gpt-5" // Updated to GPT-5 (2025)
    case "anthropic":
        return "claude-sonnet-4-5-20250929" // Updated to Claude Sonnet 4.5 (2025)
    case "xai":
        return "grok-4" // Updated to Grok 4 (2025)
    case "glm":
        return "glm-4-plus"
    case "ollama":
        return "llama3.2" // fallback
    case "lmstudio":
        return "local-model" // fallback
    default:
        return AI_PROVIDERS[provider]?.models.keys.first ?? ""
    }
}

/// Gets all available models for a provider
func getModelsForProvider(_ provider: String) -> [String: String] {
    return AI_PROVIDERS[provider]?.models ?? [:]
}

/// Gets the display name for a provider
func getProviderName(_ provider: String) -> String {
    return AI_PROVIDERS[provider]?.name ?? provider
}

/// Checks if a provider supports dynamic model loading
func hasDynamicModels(_ provider: String) -> Bool {
    return provider == "ollama" || provider == "lmstudio"
}

/// Gets an ordered list of provider IDs for display
func getProviderList() -> [String] {
    return [
        "pagespace",
        "openrouter",
        "openrouter_free",
        "google",
        "openai",
        "anthropic",
        "xai",
        "ollama",
        "lmstudio",
        "glm"
    ]
}

// MARK: - Subscription Tier Restrictions

/// Checks if a model requires a Pro or Business subscription
/// Mirrors web app's requiresSubscription() function
func requiresSubscription(provider: String, model: String) -> Bool {
    return provider == "pagespace" && model == "glm-4.6"
}

/// Checks if a user has access to a specific model based on their subscription tier
/// Mirrors web app's hasModelAccess() function
func hasModelAccess(provider: String, model: String, userTier: String?) -> Bool {
    // If the model doesn't require a subscription, it's accessible to everyone
    if !requiresSubscription(provider: provider, model: model) {
        return true
    }

    // For models that require subscription, check if user is Pro or Business
    guard let tier = userTier else {
        return false
    }

    return tier == "pro" || tier == "business"
}
