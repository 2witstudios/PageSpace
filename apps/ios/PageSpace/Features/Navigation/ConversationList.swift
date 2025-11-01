//
//  ConversationList.swift
//  PageSpace
//
//  Created on 2025-11-01.
//

import SwiftUI

/// Display conversation history for the selected agent, grouped by date
struct ConversationList: View {
    @ObservedObject var agentService: AgentService
    let closeSidebar: () -> Void

    @State private var conversations: [Conversation] = []
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if isLoading {
                HStack {
                    ProgressView()
                        .scaleEffect(0.8)
                    Text("Loading conversations...")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(.vertical, 8)
            } else if let error = error {
                Text("Error: \(error)")
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.vertical, 8)
            } else if conversations.isEmpty {
                Text("No conversations yet")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.vertical, 8)
            } else {
                ForEach(groupedConversations.keys.sorted(by: >), id: \.self) { dateGroup in
                    if let groupConversations = groupedConversations[dateGroup] {
                        // Date group header
                        Text(dateGroup)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .padding(.top, dateGroup == groupedConversations.keys.sorted(by: >).first ? 0 : 8)

                        // Conversations in this group
                        ForEach(groupConversations) { conversation in
                            conversationRow(conversation)
                        }
                    }
                }
            }
        }
        .task {
            await loadConversations()
        }
        .onChange(of: agentService.selectedAgent?.id) { oldValue, newValue in
            if oldValue != newValue {
                Task {
                    await loadConversations()
                }
            }
        }
    }

    // MARK: - Conversation Row

    private func conversationRow(_ conversation: Conversation) -> some View {
        Button(action: {
            // TODO: Load this conversation in the chat view
            // For now, just close the sidebar
            closeSidebar()
        }) {
            VStack(alignment: .leading, spacing: 4) {
                Text(conversation.title ?? "New Conversation")
                    .font(.subheadline)
                    .foregroundColor(.primary)
                    .lineLimit(1)

                if let preview = conversation.preview {
                    Text(preview)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .background(Color.gray.opacity(0.05))
            .cornerRadius(6)
        }
        .buttonStyle(PlainButtonStyle())
    }

    // MARK: - Data Loading

    private func loadConversations() async {
        isLoading = true
        error = nil

        do {
            // Fetch ALL conversations (not filtered by agent per user requirements)
            let conversationService = ConversationService.shared
            try await conversationService.loadConversations()

            // Sort by most recent first
            conversations = conversationService.conversations.sorted {
                $0.lastMessageAt > $1.lastMessageAt
            }

            isLoading = false
        } catch {
            self.error = error.localizedDescription
            conversations = []
            isLoading = false
        }
    }

    // MARK: - Date Grouping

    private var groupedConversations: [String: [Conversation]] {
        let calendar = Calendar.current
        let now = Date()

        return Dictionary(grouping: conversations) { conversation in
            let date = conversation.lastMessageAt

            if calendar.isDateInToday(date) {
                return "Today"
            } else if calendar.isDateInYesterday(date) {
                return "Yesterday"
            } else if let daysAgo = calendar.dateComponents([.day], from: date, to: now).day,
                      daysAgo <= 7 {
                return "Last 7 Days"
            } else {
                return "Older"
            }
        }
    }
}

// MARK: - Conversation Model Extension

extension Conversation {
    /// First message preview for conversation list
    var preview: String? {
        // TODO: Return first message text when we have messages loaded
        return nil
    }
}

#Preview {
    struct PreviewWrapper: View {
        @State private var isOpen = true

        var body: some View {
            VStack {
                ConversationList(
                    agentService: AgentService.shared,
                    closeSidebar: {}
                )
            }
            .padding()
            .frame(width: 280)
        }
    }

    return PreviewWrapper()
}
