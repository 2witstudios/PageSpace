import Foundation

// MARK: - Channel User

struct ChannelUser: Codable, Hashable {
    let name: String
    let image: String?

    var displayName: String {
        name.isEmpty ? "Unknown User" : name
    }

    var avatarUrl: URL? {
        guard let image = image else { return nil }
        return URL(string: image)
    }
}

// MARK: - Channel Message

struct ChannelMessage: Identifiable, Codable, Hashable {
    let id: String
    let pageId: String
    let userId: String
    let content: String
    let createdAt: Date
    let user: ChannelUser

    var isTemp: Bool {
        id.hasPrefix("temp-")
    }
}

// MARK: - API Request Models

struct SendChannelMessageRequest: Codable {
    let content: String
}
