import Foundation
import Combine

@MainActor
class ConversationService: ObservableObject {
    static let shared = ConversationService()

    @Published var conversations: [Conversation] = []
    @Published var isLoading = false
    @Published var error: Error?

    private let apiClient = APIClient.shared

    private init() {}

    // MARK: - List Conversations

    func loadConversations() async throws {
        isLoading = true
        defer { isLoading = false }

        let response: ConversationListResponse = try await apiClient.request(
            endpoint: APIEndpoints.conversations
        )

        conversations = response.conversations
    }

    // MARK: - Get Global Conversation

    func getGlobalConversation() async throws -> Conversation {
        try await apiClient.request(endpoint: APIEndpoints.globalConversation)
    }

    // MARK: - Create Conversation

    func createConversation(title: String? = nil) async throws -> Conversation {
        let request = CreateConversationRequest(title: title)
        let conversation: Conversation = try await apiClient.request(
            endpoint: APIEndpoints.conversations,
            method: .POST,
            body: request
        )

        // Add to local list
        conversations.insert(conversation, at: 0)

        return conversation
    }

    // MARK: - Update Conversation

    func updateConversation(_ id: String, title: String) async throws -> Conversation {
        let request = UpdateConversationRequest(title: title)
        let updated: Conversation = try await apiClient.request(
            endpoint: APIEndpoints.conversation(id),
            method: .PATCH,
            body: request
        )

        // Update local list
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index] = updated
        }

        return updated
    }

    // MARK: - Delete Conversation

    func deleteConversation(_ id: String) async throws {
        try await apiClient.request(
            endpoint: APIEndpoints.conversation(id),
            method: .DELETE
        ) as EmptyResponse

        // Remove from local list
        conversations.removeAll { $0.id == id }
    }

    // MARK: - Get Single Conversation

    func getConversation(_ id: String) async throws -> Conversation {
        try await apiClient.request(endpoint: APIEndpoints.conversation(id))
    }
}

// MARK: - Empty Response

struct EmptyResponse: Codable {}
