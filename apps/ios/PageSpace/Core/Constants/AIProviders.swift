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
            "anthropic/claude-3.5-sonnet": "Claude 3.5 Sonnet",
            "anthropic/claude-3.5-sonnet:beta": "Claude 3.5 Sonnet (Beta)",
            "anthropic/claude-sonnet-4-20250514": "Claude Sonnet 4",
            "anthropic/claude-3.5-haiku": "Claude 3.5 Haiku",
            "anthropic/claude-3-opus": "Claude 3 Opus",
            "openai/gpt-4o": "GPT-4o",
            "openai/gpt-4o-mini": "GPT-4o Mini",
            "openai/o1": "OpenAI o1",
            "openai/o1-mini": "OpenAI o1-mini",
            "openai/o1-preview": "OpenAI o1-preview",
            "google/gemini-2.0-flash-exp:free": "Gemini 2.0 Flash",
            "google/gemini-exp-1206:free": "Gemini Exp 1206",
            "google/gemini-2.0-flash-thinking-exp:free": "Gemini 2.0 Flash Thinking",
            "google/gemini-pro-1.5": "Gemini Pro 1.5",
            "google/gemini-flash-1.5": "Gemini Flash 1.5",
            "x-ai/grok-2-1212": "Grok 2 1212",
            "x-ai/grok-beta": "Grok Beta",
            "x-ai/grok-2-vision-1212": "Grok 2 Vision",
            "meta-llama/llama-3.3-70b-instruct": "Llama 3.3 70B",
            "meta-llama/llama-3.2-90b-vision-instruct": "Llama 3.2 90B Vision",
            "qwen/qwen-2.5-coder-32b-instruct": "Qwen 2.5 Coder 32B",
            "qwen/qwq-32b-preview": "QwQ 32B Preview",
            "deepseek/deepseek-chat": "DeepSeek Chat",
            "deepseek/deepseek-r1": "DeepSeek R1",
            "mistralai/mistral-large": "Mistral Large",
            "mistralai/mistral-small": "Mistral Small",
            "cohere/command-r-plus": "Command R+",
            "perplexity/llama-3.1-sonar-large-128k-online": "Perplexity Sonar Large"
        ]
    ),

    "openrouter_free": AIProvider(
        name: "OpenRouter (Free)",
        models: [
            "google/gemini-2.0-flash-exp:free": "Gemini 2.0 Flash",
            "google/gemini-exp-1206:free": "Gemini Exp 1206",
            "google/gemini-2.0-flash-thinking-exp:free": "Gemini 2.0 Flash Thinking",
            "meta-llama/llama-3.3-70b-instruct:free": "Llama 3.3 70B",
            "meta-llama/llama-3.2-90b-vision-instruct:free": "Llama 3.2 90B Vision",
            "qwen/qwen-2.5-coder-32b-instruct:free": "Qwen 2.5 Coder 32B",
            "qwen/qwq-32b-preview:free": "QwQ 32B Preview",
            "deepseek/deepseek-r1:free": "DeepSeek R1",
            "mistralai/mistral-7b-instruct:free": "Mistral 7B",
            "microsoft/phi-3.5-mini-128k-instruct:free": "Phi 3.5 Mini"
        ]
    ),

    "google": AIProvider(
        name: "Google AI",
        models: [
            "gemini-2.0-flash-exp": "Gemini 2.0 Flash",
            "gemini-exp-1206": "Gemini Exp 1206",
            "gemini-2.0-flash-thinking-exp-01-21": "Gemini 2.0 Flash Thinking",
            "gemini-1.5-pro": "Gemini 1.5 Pro",
            "gemini-1.5-flash": "Gemini 1.5 Flash",
            "gemini-1.5-flash-8b": "Gemini 1.5 Flash-8B"
        ]
    ),

    "openai": AIProvider(
        name: "OpenAI",
        models: [
            "gpt-4o": "GPT-4o",
            "gpt-4o-mini": "GPT-4o Mini",
            "o1": "o1",
            "o1-mini": "o1-mini",
            "o1-preview": "o1-preview",
            "gpt-4-turbo": "GPT-4 Turbo",
            "gpt-3.5-turbo": "GPT-3.5 Turbo"
        ]
    ),

    "anthropic": AIProvider(
        name: "Anthropic",
        models: [
            "claude-sonnet-4-20250514": "Claude Sonnet 4",
            "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
            "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
            "claude-3-opus-20240229": "Claude 3 Opus"
        ]
    ),

    "xai": AIProvider(
        name: "xAI",
        models: [
            "grok-2-1212": "Grok 2 1212",
            "grok-beta": "Grok Beta",
            "grok-2-vision-1212": "Grok 2 Vision"
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
func getDefaultModel(for provider: String) -> String {
    switch provider {
    case "pagespace":
        return "glm-4.5-air"
    case "openrouter":
        return "anthropic/claude-3.5-sonnet"
    case "openrouter_free":
        return "google/gemini-2.0-flash-exp:free"
    case "google":
        return "gemini-2.0-flash-exp"
    case "openai":
        return "gpt-4o"
    case "anthropic":
        return "claude-3-5-sonnet-20241022"
    case "xai":
        return "grok-2-1212"
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
