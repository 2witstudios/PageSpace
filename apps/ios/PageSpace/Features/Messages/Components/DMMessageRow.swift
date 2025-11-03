import SwiftUI

struct DMMessageRow: View {
    let message: DirectMessage
    let isSent: Bool
    let otherUser: DMUser?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if !isSent, let user = otherUser {
                // Show avatar for received messages
                AvatarView(url: user.avatarUrl, name: user.displayName, size: 32)
            } else if !isSent {
                // Fallback if no user data
                AvatarView(url: nil, name: "User", size: 32)
            }

            VStack(alignment: isSent ? .trailing : .leading, spacing: 4) {
                // Username (for received messages)
                if !isSent, let user = otherUser {
                    Text(user.displayName)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)
                }

                // Message bubble
                Text(message.content)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(isSent ? DesignTokens.Colors.primary : Color(uiColor: .systemGray5))
                    .foregroundColor(isSent ? .white : .primary)
                    .cornerRadius(16)

                // Timestamp and status
                HStack(spacing: 4) {
                    Text(message.createdAt, style: .time)
                        .font(.caption2)
                        .foregroundColor(.secondary)

                    if isSent && message.isRead {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption2)
                            .foregroundColor(DesignTokens.Colors.primary)
                    }

                    if message.isEdited {
                        Text("(edited)")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
            }

            if isSent {
                Spacer(minLength: 60) // Push sent messages to the right
            } else {
                Spacer(minLength: 60) // Push received messages to the left
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .id(message.id)
    }
}

#Preview("Sent Message") {
    let message = DirectMessage(
        id: "1",
        conversationId: "conv1",
        senderId: "me",
        content: "Hey, how are you?",
        isRead: true,
        readAt: Date(),
        isEdited: false,
        editedAt: nil,
        createdAt: Date()
    )

    DMMessageRow(message: message, isSent: true, otherUser: nil)
}

#Preview("Received Message") {
    let user = DMUser(
        id: "user1",
        name: "John Doe",
        username: "johndoe",
        email: "john@example.com",
        image: nil
    )

    let message = DirectMessage(
        id: "2",
        conversationId: "conv1",
        senderId: "user1",
        content: "I'm doing great, thanks for asking!",
        isRead: false,
        readAt: nil,
        isEdited: false,
        editedAt: nil,
        createdAt: Date()
    )

    DMMessageRow(message: message, isSent: false, otherUser: user)
}

#Preview("Conversation") {
    let user = DMUser(
        id: "user1",
        name: "Alice",
        username: "alice",
        email: "alice@example.com",
        image: nil
    )

    let messages = [
        DirectMessage(
            id: "1",
            conversationId: "conv1",
            senderId: "user1",
            content: "Hey! Are you free for a call?",
            isRead: true,
            readAt: Date(),
            isEdited: false,
            editedAt: nil,
            createdAt: Date().addingTimeInterval(-300)
        ),
        DirectMessage(
            id: "2",
            conversationId: "conv1",
            senderId: "me",
            content: "Sure! Give me 5 minutes",
            isRead: true,
            readAt: Date(),
            isEdited: false,
            editedAt: nil,
            createdAt: Date().addingTimeInterval(-240)
        ),
        DirectMessage(
            id: "3",
            conversationId: "conv1",
            senderId: "user1",
            content: "Perfect, I'll call you then",
            isRead: false,
            readAt: nil,
            isEdited: false,
            editedAt: nil,
            createdAt: Date().addingTimeInterval(-120)
        )
    ]

    ScrollView {
        VStack(spacing: 8) {
            ForEach(messages) { message in
                DMMessageRow(
                    message: message,
                    isSent: message.senderId == "me",
                    otherUser: message.senderId != "me" ? user : nil
                )
            }
        }
    }
}
