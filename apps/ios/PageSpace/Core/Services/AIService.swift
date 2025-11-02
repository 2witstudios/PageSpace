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

    // MARK: - AI Settings

    func getSettings() async throws -> AISettings {
        try await apiClient.request(endpoint: APIEndpoints.aiSettings)
    }

    func updateSettings(provider: String, model: String) async throws -> AISettings {
        struct UpdateRequest: Codable {
            let provider: String
            let model: String
        }

        let request = UpdateRequest(provider: provider, model: model)
        return try await apiClient.request(
            endpoint: APIEndpoints.aiSettings,
            method: .PATCH,
            body: request
        )
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
