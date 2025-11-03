import SwiftUI

struct DMConversationView: View {
    let thread: MessageThread

    @ObservedObject private var messagesManager = MessagesManager.shared
    @ObservedObject private var realtimeService = RealtimeService.shared

    @State private var messageText = ""
    @State private var messages: [DirectMessage] = []
    @State private var isLoading = false

    private var dmService: DirectMessagesService {
        messagesManager.directMessagesService
    }

    private var currentUserId: String {
        AuthManager.shared.currentUser?.id ?? ""
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages List
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        if isLoading && messages.isEmpty {
                            ProgressView()
                                .padding()
                        } else {
                            ForEach(messages) { message in
                                DMMessageRow(
                                    message: message,
                                    isSent: message.senderId == currentUserId,
                                    otherUser: thread.otherUser
                                )
                            }
                        }
                    }
                    .padding(.vertical, 8)
                }
                .onChange(of: messages.count) { _, _ in
                    scrollToBottom(proxy)
                }
            }

            Divider()

            // Input
            MessageInputView(
                text: $messageText,
                isSending: dmService.isSending,
                onSend: {
                    Task {
                        await sendMessage()
                    }
                }
            )
        }
        .navigationTitle(thread.title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadMessages()
            realtimeService.joinDMConversation(thread.id)
            await markAsRead()
        }
        .onDisappear {
            realtimeService.leaveDMConversation(thread.id)
        }
    }

    private func loadMessages() async {
        isLoading = true
        defer { isLoading = false }

        do {
            messages = try await dmService.fetchMessages(conversationId: thread.id)
        } catch {
            print("Failed to load messages: \(error)")
        }
    }

    private func sendMessage() async {
        let content = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }

        // Clear input immediately
        messageText = ""

        // Optimistic update
        let tempMessage = dmService.addOptimisticMessage(
            conversationId: thread.id,
            content: content,
            senderId: currentUserId
        )
        messages.append(tempMessage)

        do {
            let realMessage = try await dmService.sendMessage(
                conversationId: thread.id,
                content: content
            )

            // Replace optimistic with real message
            if let index = messages.firstIndex(where: { $0.id == tempMessage.id }) {
                messages[index] = realMessage
            }
        } catch {
            print("Failed to send message: \(error)")
            // Remove optimistic message on error
            messages.removeAll { $0.id == tempMessage.id }
        }
    }

    private func markAsRead() async {
        await messagesManager.markThreadAsRead(thread)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        if let lastMessage = messages.last {
            withAnimation {
                proxy.scrollTo(lastMessage.id, anchor: .bottom)
            }
        }
    }
}

#Preview {
    NavigationStack {
        DMConversationView(
            thread: MessageThread(
                id: "conv1",
                type: .dm,
                title: "John Doe",
                subtitle: nil,
                lastMessage: "Hey!",
                lastMessageAt: Date(),
                unreadCount: 0,
                avatarUrl: nil,
                otherUserId: "user1",
                otherUser: DMUser(
                    id: "user1",
                    name: "John Doe",
                    username: "johndoe",
                    email: "john@example.com",
                    image: nil
                ),
                pageId: nil,
                driveId: nil,
                driveName: nil
            )
        )
    }
}
