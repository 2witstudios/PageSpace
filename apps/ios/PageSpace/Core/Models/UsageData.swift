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

/// AI conversation usage data from /api/ai_conversations/{id}/usage
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
