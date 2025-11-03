import SwiftUI

struct ChannelMessageRow: View {
    let message: ChannelMessage

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // Avatar
            AvatarView(
                url: message.user.avatarUrl,
                name: message.user.displayName,
                size: 32
            )

            VStack(alignment: .leading, spacing: 4) {
                // Username and timestamp
                HStack {
                    Text(message.user.displayName)
                        .font(.caption)
                        .fontWeight(.semibold)

                    Text(message.createdAt, style: .time)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }

                // Message content
                Text(message.content)
                    .font(.body)
            }

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .id(message.id)
    }
}

#Preview("Single Message") {
    let message = ChannelMessage(
        id: "1",
        pageId: "page1",
        userId: "user1",
        content: "Welcome to the team! 👋",
        createdAt: Date(),
        user: ChannelUser(name: "Alice Johnson", image: nil)
    )

    ChannelMessageRow(message: message)
}

#Preview("Conversation") {
    let messages = [
        ChannelMessage(
            id: "1",
            pageId: "page1",
            userId: "user1",
            content: "Hey team! How's everyone doing?",
            createdAt: Date().addingTimeInterval(-600),
            user: ChannelUser(name: "Alice", image: nil)
        ),
        ChannelMessage(
            id: "2",
            pageId: "page1",
            userId: "user2",
            content: "Great! Just finished the new feature",
            createdAt: Date().addingTimeInterval(-540),
            user: ChannelUser(name: "Bob", image: nil)
        ),
        ChannelMessage(
            id: "3",
            pageId: "page1",
            userId: "user3",
            content: "Awesome work Bob! Can't wait to test it",
            createdAt: Date().addingTimeInterval(-480),
            user: ChannelUser(name: "Charlie", image: nil)
        )
    ]

    ScrollView {
        VStack(spacing: 0) {
            ForEach(messages) { message in
                ChannelMessageRow(message: message)
            }
        }
    }
}
