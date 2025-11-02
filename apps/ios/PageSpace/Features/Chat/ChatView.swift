import SwiftUI

struct ChatView: View {
    @Binding var isSidebarOpen: Bool

    @EnvironmentObject var conversationManager: ConversationManager
    @EnvironmentObject var agentService: AgentService
    @State private var messageText = ""

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
                                MessageRow(message: message)
                                    .id(message.id)
                            }

                            // Currently streaming message (separate from completed)
                            if let streamingMessage = conversationManager.streamingMessage {
                                MessageRow(message: streamingMessage)
                                    .id(streamingMessage.id)
                                    .opacity(0.95) // Subtle visual indicator
                            }
                        }
                        .padding()
                    }
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
                            .foregroundColor(.red)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32))
                            .foregroundColor(canSend ? .blue : .gray)
                    }
                }
                .disabled(!canSend && !conversationManager.isStreaming)
                .accessibilityLabel(conversationManager.isStreaming ? "Stop generating" : "Send message")
                .animation(.easeInOut(duration: 0.2), value: conversationManager.isStreaming)
            }
            .padding()
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        isSidebarOpen.toggle()
                    }
                }) {
                    Image(systemName: "line.3.horizontal")
                }
            }
            ToolbarItem(placement: .principal) {
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        isSidebarOpen.toggle()
                    }
                }) {
                    VStack(spacing: 2) {
                        if let conversation = conversationManager.currentConversation {
                            // Show conversation title
                            Text(conversation.displayTitle)
                                .font(.headline)
                            // Optionally show agent type in small text
                            Text(agentTypeLabel(conversation.type ?? "global"))
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        } else if let agent = agentService.selectedAgent {
                            // New conversation - show agent name
                            Text(agent.title)
                                .font(.headline)
                            if let subtitle = agent.subtitle {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        } else {
                            // Fallback
                            Text("Chat")
                                .font(.headline)
                        }
                    }
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                HStack(spacing: 12) {
                    // Provider/Model Picker Button
                    ProviderPickerButton()

                    // New Conversation Button
                    Button(action: {
                        conversationManager.createNewConversation()
                    }) {
                        Image(systemName: "plus")
                    }
                }
            }
        }
    }

    // MARK: - Helper Methods

    private func agentTypeLabel(_ type: String) -> String {
        switch type {
        case "global": return "Global Assistant"
        case "page": return "Page AI"
        case "drive": return "Drive AI"
        default: return ""
        }
    }

    private var canSend: Bool {
        !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversationManager.isStreaming
    }

    private func sendMessage() async {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        messageText = ""
        await conversationManager.sendMessage(text)
    }
}

#Preview {
    struct PreviewWrapper: View {
        @State private var isSidebarOpen = false
        @StateObject private var conversationManager = ConversationManager.shared
        @StateObject private var agentService = AgentService.shared

        var body: some View {
            NavigationView {
                ChatView(isSidebarOpen: $isSidebarOpen)
                    .environmentObject(conversationManager)
                    .environmentObject(agentService)
            }
        }
    }

    return PreviewWrapper()
}
