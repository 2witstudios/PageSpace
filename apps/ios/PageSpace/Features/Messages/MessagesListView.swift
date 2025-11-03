import SwiftUI

struct MessagesListView: View {
    @ObservedObject private var messagesManager = MessagesManager.shared
    @State private var searchQuery = ""
    @State private var isLoading = false

    var body: some View {
        VStack(spacing: 0) {
            // Search Bar
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                TextField("Search messages", text: $searchQuery)
                    .textFieldStyle(.plain)
                if !searchQuery.isEmpty {
                    Button(action: { searchQuery = "" }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Color(uiColor: .systemGray6))
            .cornerRadius(10)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            // Thread List
            if isLoading && messagesManager.threads.isEmpty {
                Spacer()
                ProgressView()
                Spacer()
            } else if messagesManager.threads.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(filteredThreads) { thread in
                        NavigationLink(value: thread) {
                            MessageThreadRow(thread: thread)
                        }
                    }
                }
                .listStyle(.plain)
                .refreshable {
                    await messagesManager.refreshThreads()
                }
            }
        }
        .navigationTitle("Messages")
        .navigationBarTitleDisplayMode(.large)
        .navigationDestination(for: MessageThread.self) { thread in
            if thread.type == .dm {
                DMConversationView(thread: thread)
            } else {
                ChannelChatView(thread: thread)
            }
        }
        .task {
            await loadThreads()
        }
    }

    private var filteredThreads: [MessageThread] {
        if searchQuery.isEmpty {
            return messagesManager.threads
        }
        return messagesManager.threads.filtered(by: searchQuery)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "message.circle")
                .font(.system(size: 64))
                .foregroundColor(.secondary)
            Text("No Messages Yet")
                .font(.title2)
                .fontWeight(.semibold)
            Text("Start a conversation or join a channel")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding()
    }

    private func loadThreads() async {
        isLoading = true
        defer { isLoading = false }
        do {
            try await messagesManager.loadAllThreads()
        } catch {
            print("Failed to load threads: \(error)")
        }
    }
}

#Preview {
    MessagesListView()
}
