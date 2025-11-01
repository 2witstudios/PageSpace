import SwiftUI

struct ChatView: View {
    @StateObject private var viewModel: ChatViewModel
    @State private var messageText = ""
    @Binding var isSidebarOpen: Bool

    init(agent: Agent, isSidebarOpen: Binding<Bool>) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(agent: agent))
        _isSidebarOpen = isSidebarOpen
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
                    Text(viewModel.agent.title)
                        .font(.headline)
                }
            }
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
    struct PreviewWrapper: View {
        @State private var isSidebarOpen = false

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
            }
        }
    }

    return PreviewWrapper()
}
