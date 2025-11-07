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
    /// - Returns: AiConversationUsageData containing token usage and cost
    /// - Throws: API errors if the request fails
    func fetchAiConversationUsage(conversationId: String) async throws -> AiConversationUsageData {
        let usage: AiConversationUsageData = try await apiClient.request(
            endpoint: APIEndpoints.conversationUsage(conversationId)
        )
        return usage
    }
}
