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
                            ForEach(conversationManager.messages) { message in
                                MessageRow(message: message)
                                    .id(message.id)
                            }

                            // Streaming indicator
                            if conversationManager.isStreaming {
                                HStack {
                                    ProgressView()
                                        .progressViewStyle(.circular)
                                    Text("AI is thinking...")
                                        .font(.subheadline)
                                        .foregroundColor(.secondary)
                                }
                                .padding()
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
            print("🟡 ChatView.task triggered - agent: \(agent.title), conversationId: \(agent.conversationId ?? "nil")")

            if let conversationId = agent.conversationId {
                await conversationManager.loadConversation(conversationId)
            } else {
                // New conversation - clear state
                conversationManager.createNewConversation()
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
