import Foundation

struct Conversation: Identifiable, Codable {
    let id: String
    let userId: String
    var title: String?
    let createdAt: Date
    let updatedAt: Date
    let isActive: Bool

    // Local-only properties (not from API)
    var lastMessage: String?
    var unreadCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, userId, title, createdAt, updatedAt, isActive
    }
}

struct ConversationListResponse: Codable {
    let conversations: [Conversation]
    let total: Int
}

struct ConversationMessagesResponse: Codable {
    let messages: [Message]
    let pagination: Pagination?
}

struct Pagination: Codable {
    let hasMore: Bool
    let nextCursor: String?
    let prevCursor: String?
    let limit: Int
    let direction: String
}

// MARK: - Request Bodies

struct CreateConversationRequest: Codable {
    let title: String?
}

struct UpdateConversationRequest: Codable {
    let title: String
}

struct SendMessageRequest: Codable {
    let messages: [Message]
    let selectedProvider: String?
    let selectedModel: String?
    let locationContext: LocationContext?
    let agentRole: String?

    struct LocationContext: Codable {
        let currentPage: PageInfo?
        let currentDrive: DriveInfo?
        let breadcrumbs: [String]

        struct PageInfo: Codable {
            let id: String
            let title: String
            let type: String
            let path: String
        }

        struct DriveInfo: Codable {
            let id: String
            let name: String
            let slug: String
        }
    }
}
