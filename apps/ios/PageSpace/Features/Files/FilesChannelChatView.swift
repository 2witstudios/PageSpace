//
//  FilesChannelChatView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Channel chat view for Files navigation context
//

import SwiftUI

/// Channel chat view that works within Files NavigationStack
/// Receives a Page object instead of MessageThread
struct FilesChannelChatView: View {
    let page: Page

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
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadMessages()
            realtimeService.joinChannel(page.id)
        }
        .onDisappear {
            realtimeService.leaveChannel(page.id)
        }
    }

    private func loadMessages() async {
        isLoading = true
        defer { isLoading = false }

        do {
            messages = try await channelService.fetchMessages(pageId: page.id)
        } catch {
            print("Failed to load channel messages: \(error)")
            // Check if error is permission-related
            if error.localizedDescription.contains("403") || error.localizedDescription.contains("permission") {
                canEdit = false
            }
        }
    }

    private func sendMessage() async {
        let content = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }

        // Clear input immediately
        messageText = ""

        // Optimistic update
        let tempMessage = channelService.addOptimisticMessage(
            pageId: page.id,
            content: content,
            userId: currentUserId,
            userName: currentUserName
        )
        messages.append(tempMessage)

        do {
            let realMessage = try await channelService.sendMessage(
                pageId: page.id,
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
        FilesChannelChatView(
            page: Page(
                id: "channel1",
                driveId: "drive1",
                title: "General",
                type: .channel,
                parentId: nil,
                position: 0,
                createdAt: Date(),
                updatedAt: Date()
            )
        )
    }
}
