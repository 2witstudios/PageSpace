import Foundation
import Combine

@MainActor
class PageAIService: ObservableObject {
    static let shared = PageAIService()

    private let apiClient = APIClient.shared

    private init() {}

    // MARK: - Send Message to Page AI (Streaming)

    func sendMessage(
        pageId: String,
        messages: [Message],
        conversationId: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        pageContext: PageAIMessageRequest.PageContext
    ) -> AsyncThrowingStream<StreamChunk, Error> {
        let request = PageAIMessageRequest(
            messages: messages,
            chatId: pageId,
            conversationId: conversationId,
            selectedProvider: provider,
            selectedModel: model,
            pageContext: pageContext
        )

        return AsyncThrowingStream { continuation in
            Task {
                do {
                    let stream = apiClient.streamRequest(
                        endpoint: APIEndpoints.pageAI,
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

    // MARK: - Load Page Messages

    func loadMessages(pageId: String, conversationId: String? = nil) async throws -> [Message] {
        var endpoint = APIEndpoints.pageMessages(pageId: pageId)
        if let conversationId = conversationId {
            endpoint += "&conversationId=\(conversationId)"
        }

        let response: PageAIMessagesResponse = try await apiClient.request(
            endpoint: endpoint,
            method: .GET
        )

        return response.messages
    }

    // MARK: - Get Page AI Config

    func getPageConfig(pageId: String) async throws -> PageAIConfig {
        try await apiClient.request(
            endpoint: APIEndpoints.pageAgentConfig(pageId: pageId),
            method: .GET
        )
    }

    // MARK: - Update Page AI Config

    func updatePageConfig(pageId: String, config: PageAIConfig) async throws -> PageAIConfig {
        try await apiClient.request(
            endpoint: APIEndpoints.pageAgentConfig(pageId: pageId),
            method: .PATCH,
            body: config
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
