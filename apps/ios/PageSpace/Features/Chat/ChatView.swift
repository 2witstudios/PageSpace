import SwiftUI

struct ChatView: View {
    let agent: Agent
    @Binding var isSidebarOpen: Bool

    @EnvironmentObject var conversationManager: ConversationManager
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
                        await sendMessage()
                    }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(canSend ? .blue : .gray)
                }
                .disabled(!canSend)
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
                    Text(agent.title)
                        .font(.headline)
                }
            }
        }
        .task {
            // Load conversation when view appears
            print("🟡 ChatView.task triggered - agent: \(agent.title), agentConversationId: \(agent.conversationId ?? "nil"), managerConversationId: \(conversationManager.currentConversationId ?? "nil")")

            // Check if manager already has a conversation loaded
            if let currentManagerId = conversationManager.currentConversationId {
                // Manager has a conversation loaded
                if let agentId = agent.conversationId, agentId != currentManagerId {
                    // Agent wants a different conversation - load it
                    print("ℹ️ Loading agent's conversation: \(agentId)")
                    await conversationManager.loadConversation(agentId)
                } else {
                    // Manager's conversation matches or agent has none - keep current state
                    print("ℹ️ Keeping current conversation: \(currentManagerId)")
                }
            } else if let agentId = agent.conversationId {
                // Manager has no conversation, but agent does - load it
                print("ℹ️ Loading conversation from agent: \(agentId)")
                await conversationManager.loadConversation(agentId)
            } else {
                // Both are nil - only clear if truly empty (prevent clearing during send)
                if conversationManager.messages.isEmpty && conversationManager.streamingMessage == nil {
                    print("ℹ️ Starting new conversation")
                    conversationManager.createNewConversation()
                } else {
                    print("ℹ️ Messages already exist, not clearing")
                }
            }
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

        var body: some View {
            NavigationView {
                ChatView(
                    agent: Agent(
                        id: "global_preview",
                        type: .global,
                        title: "Global Assistant",
                        subtitle: "Your personal AI assistant",
                        icon: "brain.head.profile",
                        conversationId: "global"
                    ),
                    isSidebarOpen: $isSidebarOpen
                )
                .environmentObject(conversationManager)
            }
        }
    }

    return PreviewWrapper()
}
