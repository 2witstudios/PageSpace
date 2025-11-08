//
//  UsageService.swift
//  PageSpace
//
//  Created on 2025-11-07.
//

import Foundation

/// Service for fetching AI usage and rate limiting data
@MainActor
class UsageService: ObservableObject {
    static let shared = UsageService()

    private let apiClient = APIClient.shared

    private init() {}

    /// Fetches current usage data from the subscription usage endpoint
    /// - Returns: UsageData containing current usage and limits for standard and pro tiers
    /// - Throws: API errors if the request fails
    func fetchUsageData() async throws -> UsageData {
        let usage: UsageData = try await apiClient.request(
            endpoint: APIEndpoints.subscriptionUsage
        )
        return usage
    }

    /// Fetches AI conversation usage data (tokens, context, cost)
    /// - Parameter conversationId: The conversation ID
    /// - Returns: AiConversationUsageData containing token usage and cost with calculated context window
    /// - Throws: API errors if the request fails or if the response cannot be transformed
    func fetchAiConversationUsage(conversationId: String) async throws -> AiConversationUsageData {
        print("🔄 UsageService: Requesting conversation usage for ID: \(conversationId)")

        // Decode the API response wrapper
        let apiResponse: AiConversationUsageApiResponse = try await apiClient.request(
            endpoint: APIEndpoints.conversationUsage(conversationId)
        )

        print("📦 Raw API Response:")
        print("   - Total Tokens: \(apiResponse.summary.totalTokens)")
        print("   - Total Cost: \(apiResponse.summary.totalCost)")
        print("   - Model: \(apiResponse.summary.mostRecentModel ?? "nil")")
        print("   - Provider: \(apiResponse.summary.mostRecentProvider ?? "nil")")

        // Transform to app model with calculated fields
        guard let usage = apiResponse.toUsageData() else {
            print("❌ Transformation failed: model or provider is nil")
            throw NSError(
                domain: "UsageService",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to transform usage data: missing model or provider"]
            )
        }

        print("✅ Transformation successful:")
        print("   - Context Window: \(usage.contextWindowSize)")
        print("   - Context Usage %: \(usage.contextUsagePercent)%")

        return usage
    }
}
