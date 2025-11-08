//
//  UsageData.swift
//  PageSpace
//
//  Created on 2025-11-07.
//

import Foundation

/// Represents usage limits for a specific AI tier (standard or pro)
struct UsageLimit: Codable {
    let current: Int
    let limit: Int
    let remaining: Int
}

/// Usage data from the subscription usage API
struct UsageData: Codable {
    let subscriptionTier: String  // "free", "pro", or "business"
    let standard: UsageLimit      // Standard AI calls (PageSpace Standard, other providers)
    let pro: UsageLimit           // Pro AI calls (PageSpace Pro model)
}

/// AI conversation usage data (transformed from API response)
struct AiConversationUsageData: Codable {
    let inputTokens: Int
    let outputTokens: Int
    let totalTokens: Int
    let cost: Double
    let model: String
    let provider: String
    let contextWindowSize: Int
    let contextUsagePercent: Int
}

/// API response structure from /api/ai_conversations/{id}/usage
struct AiConversationUsageApiResponse: Codable {
    let summary: UsageSummary

    struct UsageSummary: Codable {
        let totalInputTokens: Int
        let totalOutputTokens: Int
        let totalTokens: Int
        let totalCost: Double
        let mostRecentModel: String?
        let mostRecentProvider: String?
    }

    /// Transform API response to app model with calculated fields
    func toUsageData() -> AiConversationUsageData? {
        guard let model = summary.mostRecentModel,
              let provider = summary.mostRecentProvider else {
            return nil
        }

        let contextWindow = getContextWindow(model: model, provider: provider)
        let contextPercent = contextWindow > 0
            ? Int((Double(summary.totalTokens) / Double(contextWindow)) * 100)
            : 0

        return AiConversationUsageData(
            inputTokens: summary.totalInputTokens,
            outputTokens: summary.totalOutputTokens,
            totalTokens: summary.totalTokens,
            cost: summary.totalCost,
            model: model,
            provider: provider,
            contextWindowSize: contextWindow,
            contextUsagePercent: min(contextPercent, 100) // Cap at 100%
        )
    }

    /// Get context window size for a given model and provider
    /// Updated November 2025 with latest model specifications
    private func getContextWindow(model: String, provider: String) -> Int {
        switch provider.lowercased() {
        case "openai":
            // GPT-5 models (2025)
            if model.contains("gpt-5") {
                if model.contains("mini") || model.contains("nano") {
                    return 128_000
                }
                return 272_000 // GPT-5 main model
            }
            // GPT-4 family
            else if model.contains("gpt-4o") {
                return 128_000
            } else if model.contains("gpt-4-turbo") {
                return 128_000
            } else if model.contains("gpt-4") {
                return 8_192
            } else if model.contains("gpt-3.5-turbo") {
                return 16_385
            }
            return 200_000 // Default for OpenAI (newer models)

        case "anthropic":
            // Claude Sonnet 4.5 (2025)
            if model.contains("claude-sonnet-4") || model.contains("claude-4") {
                return 200_000
            }
            // Claude 3.5 family
            else if model.contains("claude-3-5") {
                return 200_000
            }
            // Claude 3 family
            else if model.contains("claude-3") {
                return 200_000
            }
            return 200_000 // Default for Anthropic

        case "google":
            // Gemini 2.5 models (2025)
            if model.contains("gemini-2.5-pro") || model.contains("gemini-2-5-pro") {
                return 2_000_000
            } else if model.contains("gemini-2.5-flash") || model.contains("gemini-2-5-flash") {
                return 1_000_000
            }
            // Gemini 2.0 models (2025)
            else if model.contains("gemini-2.0-pro") || model.contains("gemini-2-pro") {
                return 2_000_000
            } else if model.contains("gemini-2.0-flash") || model.contains("gemini-2-flash") {
                return 1_000_000
            }
            // Gemini 1.5 models
            else if model.contains("gemini-1.5-pro") {
                return 2_000_000
            } else if model.contains("gemini-1.5-flash") {
                return 1_000_000
            }
            // Legacy Gemini Pro
            else if model.contains("gemini-pro") {
                return 32_000
            }
            return 1_000_000 // Default for Google

        case "xai":
            // Grok 4 Fast (2M context) vs standard Grok models (128K)
            if model.contains("grok-4-fast") {
                return 2_000_000
            } else if model.contains("grok") {
                return 128_000 // Grok 3, Grok 4 (standard)
            }
            return 128_000 // Default for xAI

        case "openrouter":
            // OpenRouter uses various models, use conservative default
            return 200_000

        case "pagespace":
            // GLM 4.6 has 200K context (released Sept 2025)
            if model.contains("glm-4.6") {
                return 200_000
            }
            // GLM 4.5 and 4.5-air have 128K context
            else if model.contains("glm-4.5") {
                return 128_000
            }
            return 128_000 // Default for PageSpace

        default:
            return 200_000 // Conservative default for newer models
        }
    }
}
