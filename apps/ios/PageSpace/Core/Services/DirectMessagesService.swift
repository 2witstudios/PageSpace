import Foundation

@MainActor
class DirectMessagesService: ObservableObject {
    private let apiClient = APIClient.shared

    @Published var conversations: [DMConversation] = []
    @Published var currentMessages: [DirectMessage] = []
    @Published var isLoadingConversations = false
    @Published var isLoadingMessages = false
    @Published var isSending = false

    private var conversationsCursor: String?
    private var hasMoreConversations = true

    // MARK: - Fetch Conversations

    /// Fetch DM conversations with pagination
    func fetchConversations(limit: Int = 50, refresh: Bool = false) async throws -> [DMConversation] {
        if refresh {
            conversationsCursor = nil
            hasMoreConversations = true
        }

        guard hasMoreConversations else {
            return conversations
        }

        isLoadingConversations = true
        defer { isLoadingConversations = false }

        var queryParams: [String: String] = ["limit": "\(limit)"]
        if let cursor = conversationsCursor {
            queryParams["cursor"] = cursor
        }

        do {
            let response: DMConversationResponse = try await apiClient.request(
                endpoint: "/api/messages/conversations",
                method: .GET,
                queryParams: queryParams
            )

            if refresh {
                conversations = response.conversations
            } else {
                conversations.append(contentsOf: response.conversations)
            }

            conversationsCursor = response.nextCursor
            hasMoreConversations = response.nextCursor != nil

            print("✅ DirectMessagesService: Fetched \(response.conversations.count) conversations")
            return conversations
        } catch {
            print("❌ DirectMessagesService: Failed to fetch conversations: \(error)")
            throw error
        }
    }

    /// Get a specific conversation by ID
    func getConversation(id: String) -> DMConversation? {
        return conversations.first { $0.id == id }
    }

    /// Find or create conversation with a specific user
    func createConversation(recipientId: String) async throws -> DMConversation {
        let request = CreateDMConversationRequest(recipientId: recipientId)

        do {
            let conversation: DMConversation = try await apiClient.request(
                endpoint: "/api/messages/conversations",
                method: .POST,
                body: request
            )

            // Add to conversations list if not already present
            if !conversations.contains(where: { $0.id == conversation.id }) {
                conversations.insert(conversation, at: 0)
            }

            print("✅ DirectMessagesService: Created/found conversation: \(conversation.id)")
            return conversation
        } catch {
            print("❌ DirectMessagesService: Failed to create conversation: \(error)")
            throw error
        }
    }

    // MARK: - Fetch Messages

    /// Fetch messages for a specific conversation
    func fetchMessages(conversationId: String, limit: Int = 50, before: String? = nil) async throws -> [DirectMessage] {
        isLoadingMessages = true
        defer { isLoadingMessages = false }

        var queryParams: [String: String] = ["limit": "\(limit)"]
        if let before = before {
            queryParams["before"] = before
        }

        do {
            let messages: [DirectMessage] = try await apiClient.request(
                endpoint: "/api/messages/\(conversationId)",
                method: .GET,
                queryParams: queryParams
            )

            if before == nil {
                // Fresh load - replace current messages
                currentMessages = messages
            } else {
                // Pagination - prepend older messages
                currentMessages = messages + currentMessages
            }

            print("✅ DirectMessagesService: Fetched \(messages.count) messages for conversation \(conversationId)")
            return messages
        } catch {
            print("❌ DirectMessagesService: Failed to fetch messages: \(error)")
            throw error
        }
    }

    // MARK: - Send Message

    /// Send a message in a conversation
    func sendMessage(conversationId: String, content: String) async throws -> DirectMessage {
        isSending = true
        defer { isSending = false }

        let request = SendDMRequest(content: content)

        do {
            let message: DirectMessage = try await apiClient.request(
                endpoint: "/api/messages/\(conversationId)",
                method: .POST,
                body: request
            )

            // Add to current messages if this is the active conversation
            if !currentMessages.isEmpty && currentMessages.first?.conversationId == conversationId {
                currentMessages.append(message)
            }

            // Update conversation preview
            updateConversationPreview(conversationId: conversationId, message: message)

            print("✅ DirectMessagesService: Sent message in conversation \(conversationId)")
            return message
        } catch {
            print("❌ DirectMessagesService: Failed to send message: \(error)")
            throw error
        }
    }

    // MARK: - Mark as Read

    /// Mark all messages in a conversation as read
    func markAsRead(conversationId: String) async throws {
        struct EmptyResponse: Codable {}

        do {
            let _: EmptyResponse = try await apiClient.request(
                endpoint: "/api/messages/\(conversationId)",
                method: .PATCH
            )

            // Update local conversation unread count
            if let index = conversations.firstIndex(where: { $0.id == conversationId }) {
                let updatedConversation = conversations[index]
                // Create a mutable copy with unreadCount set to 0
                conversations[index] = DMConversation(
                    id: updatedConversation.id,
                    participant1Id: updatedConversation.participant1Id,
                    participant2Id: updatedConversation.participant2Id,
                    lastMessageAt: updatedConversation.lastMessageAt,
                    lastMessagePreview: updatedConversation.lastMessagePreview,
                    participant1LastRead: updatedConversation.participant1LastRead,
                    participant2LastRead: updatedConversation.participant2LastRead,
                    createdAt: updatedConversation.createdAt,
                    otherUser: updatedConversation.otherUser,
                    unreadCount: 0
                )
            }

            print("✅ DirectMessagesService: Marked conversation \(conversationId) as read")
        } catch {
            print("❌ DirectMessagesService: Failed to mark as read: \(error)")
            throw error
        }
    }

    // MARK: - Optimistic Updates

    /// Add a temporary message optimistically (before server confirmation)
    func addOptimisticMessage(conversationId: String, content: String, senderId: String) -> DirectMessage {
        let tempMessage = DirectMessage(
            id: "temp-\(Date().timeIntervalSince1970)",
            conversationId: conversationId,
            senderId: senderId,
            content: content,
            isRead: false,
            readAt: nil,
            isEdited: false,
            editedAt: nil,
            createdAt: Date()
        )

        currentMessages.append(tempMessage)
        updateConversationPreview(conversationId: conversationId, message: tempMessage)

        return tempMessage
    }

    /// Replace temporary message with real message from server
    func replaceOptimisticMessage(tempId: String, with realMessage: DirectMessage) {
        if let index = currentMessages.firstIndex(where: { $0.id == tempId }) {
            currentMessages[index] = realMessage
        }
    }

    /// Remove a temporary message (if send failed)
    func removeOptimisticMessage(tempId: String) {
        currentMessages.removeAll { $0.id == tempId }
    }

    // MARK: - Real-time Updates

    /// Handle a new message received via Socket.IO
    func handleNewMessage(_ message: DirectMessage) {
        // Don't add if it's a duplicate (already added optimistically)
        guard !currentMessages.contains(where: { $0.id == message.id }) else {
            return
        }

        // Add to messages if it belongs to the current conversation
        if !currentMessages.isEmpty && currentMessages.first?.conversationId == message.conversationId {
            currentMessages.append(message)
        }

        // Update conversation preview
        updateConversationPreview(conversationId: message.conversationId, message: message)

        print("📨 DirectMessagesService: Received new message in conversation \(message.conversationId)")
    }

    // MARK: - Helpers

    private func updateConversationPreview(conversationId: String, message: DirectMessage) {
        if let index = conversations.firstIndex(where: { $0.id == conversationId }) {
            let updatedConversation = conversations[index]

            // Update last message preview and timestamp
            conversations[index] = DMConversation(
                id: updatedConversation.id,
                participant1Id: updatedConversation.participant1Id,
                participant2Id: updatedConversation.participant2Id,
                lastMessageAt: message.createdAt,
                lastMessagePreview: message.content,
                participant1LastRead: updatedConversation.participant1LastRead,
                participant2LastRead: updatedConversation.participant2LastRead,
                createdAt: updatedConversation.createdAt,
                otherUser: updatedConversation.otherUser,
                unreadCount: updatedConversation.unreadCount
            )

            // Move to top of list
            let conversation = conversations.remove(at: index)
            conversations.insert(conversation, at: 0)
        }
    }

    /// Clear current messages (when leaving a conversation)
    func clearCurrentMessages() {
        currentMessages.removeAll()
    }
}
