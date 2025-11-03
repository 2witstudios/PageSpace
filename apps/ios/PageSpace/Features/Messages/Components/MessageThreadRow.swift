import SwiftUI

struct MessageThreadRow: View {
    let thread: MessageThread

    var body: some View {
        HStack(spacing: 12) {
            // Avatar or Channel Icon
            if thread.type == .dm {
                AvatarView(
                    url: thread.avatarUrl,
                    name: thread.title,
                    size: 48
                )
            } else {
                Image(systemName: "number.circle.fill")
                    .font(.system(size: 48))
                    .foregroundColor(.blue)
            }

            // Content
            VStack(alignment: .leading, spacing: 4) {
                // Title and Timestamp
                HStack {
                    Text(thread.title)
                        .font(.headline)
                        .lineLimit(1)

                    Spacer()

                    Text(thread.lastMessageAt, style: .relative)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                // Subtitle (drive name for channels)
                if let subtitle = thread.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }

                // Last Message Preview
                if let lastMessage = thread.lastMessage, !lastMessage.isEmpty {
                    Text(lastMessage)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                } else {
                    Text("No messages yet")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }

            // Unread Badge (DMs only)
            if let unreadCount = thread.unreadCount, unreadCount > 0 {
                ZStack {
                    Circle()
                        .fill(Color.blue)
                        .frame(width: 24, height: 24)

                    Text("\(min(unreadCount, 99))")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundColor(.white)
                }
            }
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}

#Preview("DM with Unread") {
    let thread = MessageThread(
        id: "1",
        type: .dm,
        title: "John Doe",
        subtitle: nil,
        lastMessage: "Hey, how are you doing?",
        lastMessageAt: Date().addingTimeInterval(-300),
        unreadCount: 3,
        avatarUrl: nil,
        otherUserId: "user123",
        otherUser: nil,
        pageId: nil,
        driveId: nil,
        driveName: nil
    )

    List {
        MessageThreadRow(thread: thread)
    }
}

#Preview("DM Read") {
    let thread = MessageThread(
        id: "2",
        type: .dm,
        title: "Jane Smith",
        subtitle: nil,
        lastMessage: "See you tomorrow!",
        lastMessageAt: Date().addingTimeInterval(-3600),
        unreadCount: 0,
        avatarUrl: nil,
        otherUserId: "user456",
        otherUser: nil,
        pageId: nil,
        driveId: nil,
        driveName: nil
    )

    List {
        MessageThreadRow(thread: thread)
    }
}

#Preview("Channel") {
    let thread = MessageThread(
        id: "3",
        type: .channel,
        title: "General",
        subtitle: "My Workspace",
        lastMessage: "Welcome to the team!",
        lastMessageAt: Date().addingTimeInterval(-7200),
        unreadCount: nil,
        avatarUrl: nil,
        otherUserId: nil,
        otherUser: nil,
        pageId: "page123",
        driveId: "drive123",
        driveName: "My Workspace"
    )

    List {
        MessageThreadRow(thread: thread)
    }
}

#Preview("Channel No Messages") {
    let thread = MessageThread(
        id: "4",
        type: .channel,
        title: "Random",
        subtitle: "Development Team",
        lastMessage: nil,
        lastMessageAt: Date().addingTimeInterval(-86400),
        unreadCount: nil,
        avatarUrl: nil,
        otherUserId: nil,
        otherUser: nil,
        pageId: "page456",
        driveId: "drive456",
        driveName: "Development Team"
    )

    List {
        MessageThreadRow(thread: thread)
    }
}

#Preview("Mixed List") {
    let threads = [
        MessageThread(
            id: "1",
            type: .dm,
            title: "Alice Johnson",
            subtitle: nil,
            lastMessage: "That sounds great!",
            lastMessageAt: Date().addingTimeInterval(-120),
            unreadCount: 2,
            avatarUrl: nil,
            otherUserId: "user1",
            otherUser: nil,
            pageId: nil,
            driveId: nil,
            driveName: nil
        ),
        MessageThread(
            id: "2",
            type: .channel,
            title: "Announcements",
            subtitle: "Company",
            lastMessage: "New policy updates",
            lastMessageAt: Date().addingTimeInterval(-1800),
            unreadCount: nil,
            avatarUrl: nil,
            otherUserId: nil,
            otherUser: nil,
            pageId: "page1",
            driveId: "drive1",
            driveName: "Company"
        ),
        MessageThread(
            id: "3",
            type: .dm,
            title: "Bob Williams",
            subtitle: nil,
            lastMessage: "Thanks!",
            lastMessageAt: Date().addingTimeInterval(-3600),
            unreadCount: 0,
            avatarUrl: nil,
            otherUserId: "user2",
            otherUser: nil,
            pageId: nil,
            driveId: nil,
            driveName: nil
        )
    ]

    List {
        ForEach(threads) { thread in
            MessageThreadRow(thread: thread)
        }
    }
}
