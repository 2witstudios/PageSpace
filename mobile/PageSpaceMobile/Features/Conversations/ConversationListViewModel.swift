import Foundation
import Combine

@MainActor
class ConversationListViewModel: ObservableObject {
    @Published var conversations: [Conversation] = []
    @Published var isLoading = false
    @Published var error: String?

    private let conversationService = ConversationService.shared

    func loadConversations() async {
        isLoading = true
        error = nil

        do {
            try await conversationService.loadConversations()
            conversations = conversationService.conversations
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    func createNewConversation() async {
        do {
            let conversation = try await conversationService.createConversation()
            conversations = conversationService.conversations
            // TODO: Navigate to the new conversation
        } catch {
            self.error = error.localizedDescription
        }
    }

    func deleteConversations(at indexSet: IndexSet) async {
        for index in indexSet {
            let conversation = conversations[index]
            do {
                try await conversationService.deleteConversation(conversation.id)
                conversations = conversationService.conversations
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
