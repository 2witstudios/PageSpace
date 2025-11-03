import Foundation

// MARK: - Message Thread Type

enum MessageThreadType: String, Codable, Hashable {
    case dm = "direct_message"
    case channel = "channel"
}

// MARK: - Channel With Last Message (from /api/messages/threads)

struct ChannelWithLastMessage: Codable {
    let id: String
    let title: String
    let driveId: String
    let driveName: String
    let updatedAt: Date
    let lastMessage: String?
    let lastMessageAt: Date?
}

// MARK: - Message Thread

/// Unified model representing either a DM conversation or a Channel in the Messages list
struct MessageThread: Identifiable, Hashable {
    let id: String
    let type: MessageThreadType
    let title: String
    let subtitle: String?
    let lastMessage: String?
    let lastMessageAt: Date
    let unreadCount: Int?
    let avatarUrl: URL?

    // Type-specific data
    let otherUserId: String? // For DMs
    let otherUser: DMUser? // For DMs
    let pageId: String? // For channels
    let driveId: String? // For channels
    let driveName: String? // For channels

    // MARK: - Convenience Properties

    var isDM: Bool {
        type == .dm
    }

    var isChannel: Bool {
        type == .channel
    }

    var hasUnread: Bool {
        if let count = unreadCount {
            return count > 0
        }
        return false
    }

    var displaySubtitle: String {
        if let subtitle = subtitle {
            return subtitle
        }
        return ""
    }

    // MARK: - Factory Methods

    /// Create a MessageThread from a DMConversation
    static func from(
        conversation: DMConversation,
        currentUserId: String
    ) -> MessageThread {
        let otherUser = conversation.otherUser

        return MessageThread(
            id: conversation.id,
            type: .dm,
            title: otherUser?.displayName ?? "Unknown User",
            subtitle: nil, // DMs don't have subtitles
            lastMessage: conversation.lastMessagePreview,
            lastMessageAt: conversation.lastMessageAt ?? conversation.createdAt,
            unreadCount: conversation.unreadCount,
            avatarUrl: otherUser?.avatarUrl,
            otherUserId: conversation.getOtherUserId(currentUserId: currentUserId),
            otherUser: otherUser,
            pageId: nil,
            driveId: nil,
            driveName: nil
        )
    }

    /// Create a MessageThread from a Channel
    static func from(
        channel: Channel,
        lastMessage: String? = nil,
        lastMessageAt: Date? = nil
    ) -> MessageThread {
        return MessageThread(
            id: channel.id,
            type: .channel,
            title: channel.title,
            subtitle: channel.driveName, // Show drive name as subtitle for channels
            lastMessage: lastMessage,
            lastMessageAt: lastMessageAt ?? channel.updatedAt,
            unreadCount: nil, // Channels don't track unread
            avatarUrl: nil, // Channels use icon instead
            otherUserId: nil,
            otherUser: nil,
            pageId: channel.pageId,
            driveId: channel.driveId,
            driveName: channel.driveName
        )
    }

    /// Create a MessageThread from a ChannelWithLastMessage (from /api/messages/threads)
    static func from(channelWithMessage: ChannelWithLastMessage) -> MessageThread {
        return MessageThread(
            id: channelWithMessage.id,
            type: .channel,
            title: channelWithMessage.title,
            subtitle: channelWithMessage.driveName,
            lastMessage: channelWithMessage.lastMessage,
            // Use lastMessageAt if available, otherwise fall back to updatedAt
            lastMessageAt: channelWithMessage.lastMessageAt ?? channelWithMessage.updatedAt,
            unreadCount: nil, // Channels don't track unread
            avatarUrl: nil, // Channels use icon instead
            otherUserId: nil,
            otherUser: nil,
            pageId: channelWithMessage.id,
            driveId: channelWithMessage.driveId,
            driveName: channelWithMessage.driveName
        )
    }
}

// MARK: - Sorting

extension MessageThread {
    /// Compare threads by last message time (most recent first)
    static func sortByRecent(_ lhs: MessageThread, _ rhs: MessageThread) -> Bool {
        return lhs.lastMessageAt > rhs.lastMessageAt
    }
}

// MARK: - Filtering

extension Array where Element == MessageThread {
    /// Filter threads by search query (searches title and subtitle)
    func filtered(by query: String) -> [MessageThread] {
        guard !query.isEmpty else { return self }

        let lowercased = query.lowercased()
        return filter { thread in
            thread.title.lowercased().contains(lowercased) ||
            thread.subtitle?.lowercased().contains(lowercased) == true
        }
    }

    /// Get only DM threads
    var dms: [MessageThread] {
        filter { $0.type == .dm }
    }

    /// Get only channel threads
    var channels: [MessageThread] {
        filter { $0.type == .channel }
    }

    /// Get total unread count across all DM threads
    var totalUnreadCount: Int {
        dms.reduce(0) { $0 + ($1.unreadCount ?? 0) }
    }
}
