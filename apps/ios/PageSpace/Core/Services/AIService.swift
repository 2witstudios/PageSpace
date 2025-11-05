import Foundation
import Combine

@MainActor
class AIService: ObservableObject {
    static let shared = AIService()

    private let apiClient = APIClient.shared

    private init() {}

    // MARK: - Send Message (Streaming)

    func sendMessage(
        conversationId: String,
        messages: [Message],
        provider: String? = nil,
        model: String? = nil
    ) -> AsyncThrowingStream<StreamChunk, Error> {
        let request = SendMessageRequest(
            messages: messages,
            selectedProvider: provider,
            selectedModel: model,
            locationContext: nil,
            agentRole: "PARTNER"
        )

        let endpoint = APIEndpoints.conversationMessages(conversationId)

        return AsyncThrowingStream { continuation in
            Task {
                do {
                    let stream = apiClient.streamRequest(
                        endpoint: endpoint,
                        method: .POST,
                        body: request
                    )

                    for try await event in stream {
                        // Parse SSE event data
                        if let chunk = parseStreamChunk(event.data) {
                            continuation.yield(chunk)
                        }

                        // Check for finish event
                        if event.event == "finish" || event.data.contains("\"type\":\"finish\"") {
                            continuation.finish()
                            return
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Load Messages

    func loadMessages(conversationId: String, limit: Int = 50, cursor: String? = nil) async throws -> ConversationMessagesResponse {
        var queryParams = ["limit": String(limit)]
        if let cursor = cursor {
            queryParams["cursor"] = cursor
        }

        let endpoint = APIEndpoints.conversationMessages(conversationId)
        let response: ConversationMessagesResponse = try await apiClient.request(
            endpoint: endpoint,
            method: .GET,
            queryParams: queryParams
        )

        return response
    }

    // MARK: - Message Mutations

    func editMessage(conversationId: String, messageId: String, content: String) async throws {
        let request = EditMessageRequest(content: content)
        let endpoint = APIEndpoints.conversationMessage(conversationId, messageId: messageId)
        let _: MessageMutationResponse = try await apiClient.request(
            endpoint: endpoint,
            method: .PATCH,
            body: request
        )
    }

    func deleteMessage(conversationId: String, messageId: String) async throws {
        let endpoint = APIEndpoints.conversationMessage(conversationId, messageId: messageId)
        let _: MessageMutationResponse = try await apiClient.request(
            endpoint: endpoint,
            method: .DELETE
        )
    }

    // MARK: - AI Settings

    func getSettings() async throws -> AISettings {
        try await apiClient.request(endpoint: APIEndpoints.aiSettings)
    }

    func updateSettings(provider: String, model: String) async throws -> AISettings {
        struct UpdateRequest: Codable {
            let provider: String
            let model: String
        }

        struct UpdateResponse: Codable {
            let success: Bool
            let provider: String
            let model: String
            let message: String
        }

        let request = UpdateRequest(provider: provider, model: model)

        // PATCH returns simple success response, not full AISettings
        let _: UpdateResponse = try await apiClient.request(
            endpoint: APIEndpoints.aiSettings,
            method: .PATCH,
            body: request
        )

        // Fetch updated settings after successful update
        return try await getSettings()
    }

    // MARK: - Agent Configuration

    /// Get agent-specific configuration for a page
    func getAgentConfig(pageId: String) async throws -> AgentConfig {
        let endpoint = "/api/pages/\(pageId)/agent-config"
        return try await apiClient.request(endpoint: endpoint)
    }

    // MARK: - Dynamic Models

    /// Load available models from Ollama
    func getOllamaModels() async throws -> [String] {
        struct OllamaResponse: Codable {
            let models: [String]
        }
        let response: OllamaResponse = try await apiClient.request(endpoint: "/api/ai/ollama/models")
        return response.models
    }

    /// Load available models from LM Studio
    func getLMStudioModels() async throws -> [String] {
        struct LMStudioResponse: Codable {
            let models: [String]
        }
        let response: LMStudioResponse = try await apiClient.request(endpoint: "/api/ai/lmstudio/models")
        return response.models
    }

    // MARK: - Stream Parsing

    private func parseStreamChunk(_ data: String) -> StreamChunk? {
        guard let jsonData = data.data(using: .utf8) else { return nil }

        do {
            let decoder = JSONDecoder()
            let chunk = try decoder.decode(StreamChunk.self, from: jsonData)
            return chunk
        } catch {
            print("Failed to decode stream chunk: \(error)")
            return nil
        }
    }
}

// MARK: - Stream Chunk Model

struct StreamChunk: Codable {
    let type: String
    let index: Int?
    let delta: String?  // For text-delta events

    // Tool call fields (flat at top level - matches Vercel AI SDK v5 format)
    let toolCallId: String?
    let toolName: String?
    let input: AnyCodable?

    // Tool result fields (flat at top level)
    let output: AnyCodable?

    // Error handling
    let isError: Bool?

    // Optional metadata
    let providerExecuted: Bool?
    let dynamic: Bool?
    let preliminary: Bool?
}

// MARK: - Message Mutation Models

private struct EditMessageRequest: Codable {
    let content: String
}

private struct MessageMutationResponse: Codable {
    let success: Bool
    let message: String?
}
