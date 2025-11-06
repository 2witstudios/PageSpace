//
//  FilesAgentChatView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Agent chat view for Files navigation context
//

import SwiftUI

/// Agent chat view that works within Files NavigationStack
/// Receives a Page object and creates/loads conversation for that page AI
struct FilesAgentChatView: View {
    let page: Page

    @StateObject private var conversationManager = ConversationManager.shared
    @State private var messageText = ""
    @State private var hasLoadedConversation = false

    var body: some View {
        VStack(spacing: 0) {
            messagesSection
            Divider()
            inputSection
        }
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                // Provider/Model Picker Button
                ProviderPickerButton()
            }
        }
        .task {
            // Load or create conversation for this page AI agent
            if !hasLoadedConversation {
                await loadPageConversation()
                hasLoadedConversation = true
            }
        }
    }

    // MARK: - Helper Methods

    @ViewBuilder
    private var messagesSection: some View {
        if conversationManager.conversationState.isLoadingConversation {
            ProgressView("Loading conversation...")
                .frame(maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    conversationMessageList
                }
                .scrollDismissesKeyboard(.immediately)
                .onChange(of: conversationManager.messageState.count) { _, _ in
                    if let lastMessage = conversationManager.messageState.lastMessage {
                        withAnimation {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
                        }
                    }
                }
                .onChange(of: conversationManager.streamingState.streamingMessage?.id) { _, newValue in
                    if let streamingId = newValue {
                        withAnimation {
                            proxy.scrollTo(streamingId, anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var conversationMessageList: some View {
        let messages = conversationManager.messageState.messages
        LazyVStack(spacing: 16) {
            ForEach(messages) { message in
                messageRow(for: message)
            }

            if let streamingMessage = conversationManager.streamingState.streamingMessage {
                MessageRow(
                    message: streamingMessage,
                    onCopy: nil,
                    onEdit: nil,
                    onRetry: nil,
                    onDelete: nil
                )
                .id(streamingMessage.id)
                .opacity(0.95) // Subtle visual indicator
            }
        }
        .padding()
    }

    @ViewBuilder
    private func messageRow(for message: Message) -> some View {
        MessageRow(
            message: message,
            onCopy: nil,
            onEdit: nil,
            onRetry: nil,
            onDelete: nil
        )
        .id(message.id)
    }

    private var inputSection: some View {
        HStack(spacing: 12) {
            TextField("Message...", text: $messageText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
                .disabled(conversationManager.streamingState.isStreaming)

            Button {
                Task {
                    if conversationManager.streamingState.isStreaming {
                        conversationManager.stopStreaming()
                    } else {
                        await sendMessage()
                    }
                }
            } label: {
                if conversationManager.streamingState.isStreaming {
                    Image(systemName: "stop.circle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(DesignTokens.Colors.error)
                } else {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(canSend ? DesignTokens.Colors.primary : .gray)
                }
            }
            .disabled(!canSend && !conversationManager.streamingState.isStreaming)
            .accessibilityLabel(conversationManager.streamingState.isStreaming ? "Stop generating" : "Send message")
            .animation(.easeInOut(duration: 0.2), value: conversationManager.streamingState.isStreaming)
        }
        .padding()
    }

    private var canSend: Bool {
        !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversationManager.streamingState.isStreaming
    }

    private func sendMessage() async {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        messageText = ""
        await conversationManager.sendMessage(text)
    }

    private func loadPageConversation() async {
        // Set the agent context to this page AI
        conversationManager.selectedAgentType = "page"
        conversationManager.selectedAgentContextId = page.id

        // Load or create conversation for this page AI
        if conversationManager.conversationState.currentConversation == nil {
            conversationManager.createNewConversation()
        }
    }
}

#Preview {
    NavigationStack {
        FilesAgentChatView(
            page: Page(
                id: "agent1",
                driveId: "drive1",
                title: "Project Assistant",
                type: .aiChat,
                parentId: nil,
                position: 0,
                createdAt: Date(),
                updatedAt: Date()
            )
        )
    }
}
