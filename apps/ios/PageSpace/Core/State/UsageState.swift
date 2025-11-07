//
//  UsageState.swift
//  PageSpace
//
//  Created on 2025-11-07.
//

import Foundation
import Observation

/// Observable state for managing AI usage and rate limiting data
@Observable
final class UsageState {
    var usageData: UsageData?
    var aiUsageData: AiConversationUsageData?
    var isLoading: Bool = false
    var error: String?

    /// Fetches current usage data from the API
    func fetchUsage() async {
        isLoading = true
        error = nil

        do {
            let data = try await UsageService.shared.fetchUsageData()
            usageData = data
        } catch {
            self.error = error.localizedDescription
            print("Error fetching usage data: \(error)")
        }

        isLoading = false
    }

    /// Fetches AI conversation usage (tokens, context, cost)
    func fetchAiConversationUsage(conversationId: String) async {
        do {
            let data = try await UsageService.shared.fetchAiConversationUsage(conversationId: conversationId)
            aiUsageData = data
        } catch {
            print("Error fetching AI conversation usage: \(error)")
        }
    }

    /// Returns a formatted rate limit display string based on provider, model, and subscription tier
    /// - Parameters:
    ///   - provider: The AI provider (e.g., "pagespace", "openai", etc.)
    ///   - model: The selected model (e.g., "glm-4.6", "glm-4.5-air")
    ///   - tier: The user's subscription tier (e.g., "free", "pro", "business")
    ///   - agentName: Optional agent name (only included for existing conversations)
    /// - Returns: Formatted string like "Standard 0/20" or "Global Assistant 0/20" (with agent name)
    func getRateLimitDisplay(provider: String?, model: String?, tier: String?, agentName: String? = nil) -> String {
        // Handle loading and error states
        if isLoading {
            return "Loading..."
        }

        if error != nil {
            return "Usage unavailable"
        }

        guard let usage = usageData else {
            return "Usage unavailable"
        }

        // Determine the usage string based on provider/model
        let usageString: String

        if let provider = provider, provider == "pagespace" {
            if model == "glm-4.6" {
                // Pro model - show pro usage
                usageString = "Pro AI \(usage.pro.current)/\(usage.pro.limit)"
            } else {
                // Standard model (glm-4.5-air or default) - show standard usage
                usageString = "Standard \(usage.standard.current)/\(usage.standard.limit)"
            }
        } else {
            // All other providers use standard limits
            usageString = "AI \(usage.standard.current)/\(usage.standard.limit)"
        }

        // Prepend agent name if provided (for existing conversations)
        if let agentName = agentName {
            return "\(agentName) \(usageString)"
        } else {
            return usageString
        }
    }

    /// Returns a formatted token breakdown display string
    /// Format: "45% • 2.5K • $0.01" for new conversations
    /// Format: "Global Assistant • 45% • 2.5K • $0.01" for existing conversations
    /// - Parameter agentName: Optional agent name (only included for existing conversations)
    /// - Returns: Formatted string with optional agent name, context %, total tokens, and cost (if > 0)
    func getTokenBreakdownDisplay(agentName: String? = nil) -> String {
        guard let aiUsage = aiUsageData else {
            return "No usage data"
        }

        let contextPercent = "\(aiUsage.contextUsagePercent)%"
        let totalTokens = formatNumber(aiUsage.totalTokens)

        var parts: [String] = []

        // Add agent name if provided (for existing conversations)
        if let agentName = agentName {
            parts.append(agentName)
        }

        parts.append(contextPercent)
        parts.append(totalTokens)

        // Only show cost if greater than 0
        if aiUsage.cost > 0 {
            parts.append(formatCost(aiUsage.cost))
        }

        return parts.joined(separator: " • ")
    }

    /// Format number (e.g., 1000 → "1K", 1000000 → "1M")
    private func formatNumber(_ num: Int) -> String {
        if num >= 1_000_000 {
            return String(format: "%.1fM", Double(num) / 1_000_000)
        } else if num >= 1_000 {
            return String(format: "%.1fK", Double(num) / 1_000)
        } else {
            return "\(num)"
        }
    }

    /// Format cost (e.g., 0.001 → "$0.00", 0.01 → "$0.01")
    private func formatCost(_ cost: Double) -> String {
        if cost < 0.01 {
            return String(format: "$%.4f", cost)
        } else {
            return String(format: "$%.2f", cost)
        }
    }
}
