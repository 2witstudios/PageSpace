import SwiftUI

struct ChannelChatView: View {
    let thread: MessageThread

    @ObservedObject private var messagesManager = MessagesManager.shared
    @ObservedObject private var realtimeService = RealtimeService.shared

    @State private var messageText = ""
    @State private var messages: [ChannelMessage] = []
    @State private var isLoading = false
    @State private var canEdit = true

    private var channelService: ChannelService {
        messagesManager.channelMessagingService
    }

    private var currentUserId: String {
        AuthManager.shared.currentUser?.id ?? ""
    }

    private var currentUserName: String {
        AuthManager.shared.currentUser?.name ?? "User"
    }

    var body: some View {
        VStack(spacing: 0) {
            // Channel Info Header (if needed)
            if let driveName = thread.driveName {
                HStack {
                    Image(systemName: "number.circle.fill")
                        .foregroundColor(DesignTokens.Colors.channel)
                    Text(thread.title)
                        .font(.headline)
                    Text("·")
                        .foregroundColor(.secondary)
                    Text(driveName)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color(uiColor: .systemGray6))
            }

            // Permission Warning
            if !canEdit {
                HStack {
                    Image(systemName: "lock.fill")
                        .foregroundColor(DesignTokens.Colors.warning)
                    Text("You can view messages but cannot send in this channel")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(DesignTokens.Colors.warning.opacity(0.1))
            }

            // Messages List
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if isLoading && messages.isEmpty {
                            ProgressView()
                                .padding()
                        } else {
                            ForEach(messages) { message in
                                ChannelMessageRow(message: message)
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
                isDisabled: !canEdit,
                isSending: channelService.isSending,
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
            if let pageId = thread.pageId {
                realtimeService.joinChannel(pageId)
            }
        }
        .onDisappear {
            if let pageId = thread.pageId {
                realtimeService.leaveChannel(pageId)
            }
        }
    }

    private func loadMessages() async {
        guard let pageId = thread.pageId else { return }

        isLoading = true
        defer { isLoading = false }

        do {
            messages = try await channelService.fetchMessages(pageId: pageId)
        } catch {
            print("Failed to load channel messages: \(error)")
            // Check if error is permission-related
            if error.localizedDescription.contains("403") || error.localizedDescription.contains("permission") {
                canEdit = false
            }
        }
    }

    private func sendMessage() async {
        guard let pageId = thread.pageId else { return }

        let content = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }

        // Clear input immediately
        messageText = ""

        // Optimistic update
        let tempMessage = channelService.addOptimisticMessage(
            pageId: pageId,
            content: content,
            userId: currentUserId,
            userName: currentUserName
        )
        messages.append(tempMessage)

        do {
            let realMessage = try await channelService.sendMessage(
                pageId: pageId,
                content: content
            )

            // Replace optimistic with real message
            if let index = messages.firstIndex(where: { $0.id == tempMessage.id }) {
                messages[index] = realMessage
            }
        } catch {
            print("Failed to send channel message: \(error)")
            // Remove optimistic message on error
            messages.removeAll { $0.id == tempMessage.id }

            // Check if permission error
            if error.localizedDescription.contains("403") || error.localizedDescription.contains("permission") {
                canEdit = false
            }
        }
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
        ChannelChatView(
            thread: MessageThread(
                id: "channel1",
                type: .channel,
                title: "General",
                subtitle: "My Workspace",
                lastMessage: "Welcome!",
                lastMessageAt: Date(),
                unreadCount: nil,
                avatarUrl: nil,
                otherUserId: nil,
                otherUser: nil,
                pageId: "page1",
                driveId: "drive1",
                driveName: "My Workspace"
            )
        )
    }
}
