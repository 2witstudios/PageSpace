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
            // Messages List
            if conversationManager.isLoadingConversation {
                // Show loading state while conversation loads
                ProgressView("Loading conversation...")
                    .frame(maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            // Completed messages
                            ForEach(conversationManager.messages) { message in
                                MessageRow(
                                    message: message,
                                    onCopy: nil,
                                    onEdit: nil,
                                    onRetry: nil
                                )
                                .id(message.id)
                            }

                            // Currently streaming message (separate from completed)
                            if let streamingMessage = conversationManager.streamingMessage {
                                MessageRow(
                                    message: streamingMessage,
                                    onCopy: nil,
                                    onEdit: nil,
                                    onRetry: nil
                                )
                                .id(streamingMessage.id)
                                .opacity(0.95) // Subtle visual indicator
                            }
                        }
                        .padding()
                    }
                    .scrollDismissesKeyboard(.immediately)
                    .onChange(of: conversationManager.messages.count) { oldValue, newValue in
                        // Auto-scroll to bottom when new messages arrive
                        if let lastMessage = conversationManager.messages.last {
                            withAnimation {
                                proxy.scrollTo(lastMessage.id, anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: conversationManager.streamingMessage?.id) { oldValue, newValue in
                        // Auto-scroll when streaming message appears or updates
                        if let streamingId = newValue {
                            withAnimation {
                                proxy.scrollTo(streamingId, anchor: .bottom)
                            }
                        }
                    }
                }
            }

            Divider()

            // Input Area
            HStack(spacing: 12) {
                TextField("Message...", text: $messageText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)
                    .disabled(conversationManager.isStreaming)

                Button {
                    Task {
                        if conversationManager.isStreaming {
                            conversationManager.stopStreaming()
                        } else {
                            await sendMessage()
                        }
                    }
                } label: {
                    if conversationManager.isStreaming {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 32))
                            .foregroundColor(DesignTokens.Colors.error)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32))
                            .foregroundColor(canSend ? DesignTokens.Colors.primary : .gray)
                    }
                }
                .disabled(!canSend && !conversationManager.isStreaming)
                .accessibilityLabel(conversationManager.isStreaming ? "Stop generating" : "Send message")
                .animation(.easeInOut(duration: 0.2), value: conversationManager.isStreaming)
            }
            .padding()
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

    private var canSend: Bool {
        !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversationManager.isStreaming
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
        if conversationManager.currentConversation == nil {
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
