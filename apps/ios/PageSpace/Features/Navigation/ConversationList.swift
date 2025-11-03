//
//  ConversationList.swift
//  PageSpace
//
//  Created on 2025-11-01.
//  Updated for minimal, modern aesthetic
//

import SwiftUI

/// Display conversation history for the selected agent, grouped by date
/// Minimal styling with hairline separators and subtle hover states
struct ConversationList: View {
    @ObservedObject var agentService: AgentService
    @EnvironmentObject var conversationManager: ConversationManager
    let closeSidebar: () -> Void

    @State private var conversations: [Conversation] = []
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if isLoading {
                HStack(spacing: DesignTokens.Spacing.small) {
                    ProgressView()
                        .scaleEffect(0.8)
                    Text("Loading conversations...")
                        .font(.caption)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                }
                .padding(.vertical, DesignTokens.Spacing.small)
            } else if let error = error {
                Text("Error: \(error)")
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.vertical, DesignTokens.Spacing.small)
            } else if conversations.isEmpty {
                Text("No conversations yet")
                    .font(.caption)
                    .foregroundColor(DesignTokens.Colors.mutedText)
                    .padding(.vertical, DesignTokens.Spacing.small)
            } else {
                // Display all conversations in a single list
                ForEach(conversations) { conversation in
                    conversationRow(conversation)
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

    @ViewBuilder
    private func conversationRow(_ conversation: Conversation) -> some View {
        ConversationRowButton(
            conversation: conversation,
            isSelected: conversationManager.currentConversation?.id == conversation.id,
            action: {
                Task {
                    // Load this conversation in the chat view
                    await selectConversation(conversation)

                    // Close sidebar AFTER conversation loads
                    closeSidebar()
                }
            }
        )
    }

    // MARK: - Conversation Selection

    private func selectConversation(_ conversation: Conversation) async {
        print("🟣 ConversationList.selectConversation - conversationId: \(conversation.id), title: \(conversation.displayTitle)")

        // Simply load the conversation directly
        await conversationManager.loadConversation(conversation)

        print("✅ Conversation switched to: \(conversation.displayTitle)")
    }

    // MARK: - Data Loading

    private func loadConversations() async {
        isLoading = true
        error = nil

        do {
            // Fetch ALL conversations (not filtered by agent per user requirements)
            let conversationService = ConversationService.shared
            try await conversationService.loadConversations()

            // Filter out empty conversations and sort by most recent first
            conversations = conversationService.conversations
                .filter { $0.title != nil }
                .sorted { $0.lastMessageAt > $1.lastMessageAt }

            isLoading = false
        } catch {
            self.error = error.localizedDescription
            conversations = []
            isLoading = false
        }
    }

}

// MARK: - Conversation Row Button Component

/// Minimal conversation row with hover state and selection indicator
struct ConversationRowButton: View {
    let conversation: Conversation
    let isSelected: Bool
    let action: () -> Void

    @State private var isPressed = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 0) {
                // Accent bar for selected state
                if isSelected {
                    Rectangle()
                        .fill(DesignTokens.Colors.accentBar)
                        .frame(width: 2)
                } else {
                    Color.clear
                        .frame(width: 2)
                }

                // Content
                VStack(alignment: .leading, spacing: DesignTokens.Spacing.xxsmall) {
                    Text(conversation.title ?? "Recent conversation")
                        .font(.subheadline)
                        .fontWeight(isSelected ? .medium : .regular)
                        .foregroundColor(conversation.title != nil ? .primary : DesignTokens.Colors.mutedText)
                        .tracking(DesignTokens.Typography.bodyTracking)
                        .lineLimit(1)

                    if let preview = conversation.preview {
                        Text(preview)
                            .font(.caption)
                            .foregroundColor(DesignTokens.Colors.mutedText)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, DesignTokens.Spacing.small)
                .padding(.horizontal, DesignTokens.Spacing.medium)
            }
            .background(backgroundColor)
            .contentShape(Rectangle())
            .animation(DesignTokens.Animation.quickTransition, value: isPressed)
            .animation(DesignTokens.Animation.quickTransition, value: isSelected)
        }
        .buttonStyle(GhostButtonStyle(isPressed: $isPressed))
    }

    private var backgroundColor: Color {
        if isSelected {
            return DesignTokens.Colors.activeBackground
        } else if isPressed {
            return DesignTokens.Colors.conversationHover
        }
        return Color.clear
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
            .frame(width: DesignTokens.Spacing.sidebarWidth)
        }
    }

    return PreviewWrapper()
}
