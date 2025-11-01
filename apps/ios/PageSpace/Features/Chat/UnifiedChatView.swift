import SwiftUI

struct UnifiedChatView: View {
    @StateObject private var viewModel: UnifiedChatViewModel
    @State private var messageText = ""
    @State private var showAgentPicker = false

    init(agent: Agent) {
        _viewModel = StateObject(wrappedValue: UnifiedChatViewModel(agent: agent))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages List
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 16) {
                        ForEach(viewModel.messages) { message in
                            MessageRow(message: message)
                                .id(message.id)
                        }

                        // Streaming indicator
                        if viewModel.isStreaming {
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
                .onChange(of: viewModel.messages.count) { oldValue, newValue in
                    // Auto-scroll to bottom when new messages arrive
                    if let lastMessage = viewModel.messages.last {
                        withAnimation {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
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
                    .disabled(viewModel.isStreaming)

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
        .navigationTitle(viewModel.agent.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    showAgentPicker = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: viewModel.agent.icon)
                        if viewModel.agent.type == .pageAI {
                            Text("Agent")
                                .font(.caption)
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $showAgentPicker) {
            AgentPickerView()
        }
        .task {
            await viewModel.loadMessages()
        }
    }

    private var canSend: Bool {
        !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !viewModel.isStreaming
    }

    private func sendMessage() async {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        messageText = ""
        await viewModel.sendMessage(text)
    }
}

#Preview {
    NavigationView {
        UnifiedChatView(agent: Agent(
            id: "global_preview",
            type: .global,
            title: "Global Assistant",
            subtitle: "Your personal AI assistant",
            icon: "brain.head.profile",
            conversationId: "global"
        ))
    }
}
