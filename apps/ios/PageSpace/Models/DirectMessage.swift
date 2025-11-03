import Foundation

// MARK: - DM User

struct DMUser: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let username: String
    let email: String
    let image: String?

    var displayName: String {
        name.isEmpty ? username : name
    }

    var avatarUrl: URL? {
        guard let image = image else { return nil }
        return URL(string: image)
    }
}

// MARK: - Direct Message

struct DirectMessage: Identifiable, Codable, Hashable {
    let id: String
    let conversationId: String
    let senderId: String
    let content: String
    let isRead: Bool
    let readAt: Date?
    let isEdited: Bool
    let editedAt: Date?
    let createdAt: Date

    var isTemp: Bool {
        id.hasPrefix("temp-")
    }
}

// MARK: - DM Conversation

struct DMConversation: Identifiable, Codable, Hashable {
    let id: String
    let participant1Id: String
    let participant2Id: String
    let lastMessageAt: Date?
    let lastMessagePreview: String?
    let participant1LastRead: Date?
    let participant2LastRead: Date?
    let createdAt: Date

    /// The other user in this conversation (not the current user)
    var otherUser: DMUser?

    /// Number of unread messages for the current user
    var unreadCount: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case participant1Id
        case participant2Id
        case lastMessageAt
        case lastMessagePreview
        case participant1LastRead
        case participant2LastRead
        case createdAt
        case otherUser
        case unreadCount
    }

    func getOtherUserId(currentUserId: String) -> String {
        return participant1Id == currentUserId ? participant2Id : participant1Id
    }

    func getLastRead(for userId: String) -> Date? {
        return participant1Id == userId ? participant1LastRead : participant2LastRead
    }
}

// MARK: - API Response Models

struct DMConversationResponse: Codable {
    let conversations: [DMConversation]
    let nextCursor: String?
}

// Note: These are different from the AI chat requests in Core/Models/Conversation.swift
struct SendDMRequest: Codable {
    let content: String
}

struct CreateDMConversationRequest: Codable {
    let recipientId: String
}
