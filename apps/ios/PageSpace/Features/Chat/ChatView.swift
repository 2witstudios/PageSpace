import SwiftUI
import UIKit

struct ChatView: View {
    @Binding var isSidebarOpen: Bool

    @EnvironmentObject var conversationManager: ConversationManager
    @EnvironmentObject var agentService: AgentService
    @State private var messageText = ""
    @FocusState private var isTextFieldFocused: Bool
    @State private var editingContext: MessageEditContext?
    @State private var isSavingEdit = false
    @State private var alertMessage: String?
    @State private var messagePendingDeletion: Message?
    @State private var isShowingDeleteConfirmation = false
    @State private var showTokenBreakdown = false  // Toggle between rate limiting and token breakdown

    var body: some View {
        VStack(spacing: 0) {
            messagesSection

            Divider()

            // Input Area
            HStack(spacing: 12) {
                TextField("Message...", text: $messageText, axis: .vertical)
                    .focused($isTextFieldFocused)
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
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        isSidebarOpen.toggle()
                    }
                }) {
                    Image(systemName: "line.3.horizontal")
                        .foregroundColor(DesignTokens.Colors.primary)
                }
            }
            ToolbarItem(placement: .principal) {
                Button(action: {
                    showTokenBreakdown.toggle()
                }) {
                    VStack(spacing: 2) {
                        // LINE 1: Always show title (conversation title or agent name)
                        if let conversation = conversationManager.conversationState.currentConversation {
                            // Existing conversation - show conversation title
                            Text(conversation.displayTitle)
                                .font(.headline)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        } else if let agent = agentService.selectedAgent {
                            // New conversation - show agent name
                            Text(agent.title)
                                .font(.headline)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        } else {
                            // Fallback
                            Text("Chat")
                                .font(.headline)
                        }

                        // LINE 2: Toggle between rate limiting and token breakdown
                        if showTokenBreakdown {
                            // Show token breakdown with color coding based on context usage
                            let agentName = conversationManager.conversationState.currentConversation != nil ? agentTypeLabel(conversationManager.conversationState.currentConversation?.type ?? "global") : nil
                            let colorName = conversationManager.usageState.getContextUsageColor()
                            Text(conversationManager.usageState.getTokenBreakdownDisplay(agentName: agentName))
                                .font(.caption)
                                .foregroundColor(colorForName(colorName))
                                .lineLimit(1)
                                .truncationMode(.tail)
                        } else {
                            // Show rate limiting (default)
                            let agentName = conversationManager.conversationState.currentConversation != nil ? agentTypeLabel(conversationManager.conversationState.currentConversation?.type ?? "global") : nil
                            Text(conversationManager.usageState.getRateLimitDisplay(
                                provider: conversationManager.settingsState.selectedProvider,
                                model: conversationManager.settingsState.selectedModel,
                                tier: conversationManager.settingsState.providerSettings?.userSubscriptionTier,
                                agentName: agentName
                            ))
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        }
                    }
                    .frame(maxWidth: 200)
                }
                .buttonStyle(.plain)
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
                            .foregroundColor(DesignTokens.Colors.primary)
                    }
                }
            }
        }
        .task(id: conversationManager.conversationState.currentConversationId) {
            // Fetch usage data when conversation ID changes (includes switching between chats)
            await conversationManager.usageState.fetchUsage()

            // Fetch AI conversation usage if we have a conversation
            if let conversationId = conversationManager.conversationState.currentConversationId {
                await conversationManager.usageState.fetchAiConversationUsage(conversationId: conversationId)
            }
        }
        .onChange(of: isSidebarOpen) { oldValue, newValue in
            if newValue {
                // Dismiss keyboard when sidebar opens
                isTextFieldFocused = false
            }
        }
        .sheet(item: $editingContext) { context in
            MessageEditSheet(
                context: context,
                isSaving: isSavingEdit,
                onCancel: { editingContext = nil },
                onSave: { newText in
                    handleEditSave(for: context, updatedText: newText)
                }
            )
        }
        .alert(
            "Something Went Wrong",
            isPresented: Binding(
                get: { alertMessage != nil },
                set: { newValue in
                    if !newValue {
                        alertMessage = nil
                    }
                }
            ),
            actions: {
            Button("OK", role: .cancel) {
                alertMessage = nil
            }
        }, message: {
            Text(alertMessage ?? "")
        })
        .confirmationDialog(
            "Delete Message?",
            isPresented: $isShowingDeleteConfirmation,
            titleVisibility: .visible,
            presenting: messagePendingDeletion
        ) { message in
            Button("Delete", role: .destructive) {
                performDelete(for: message)
            }
            Button("Cancel", role: .cancel) {
                messagePendingDeletion = nil
            }
        } message: { message in
            Text("This will permanently remove the selected message from the conversation.")
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
                    // Use state objects for accessing data
                    let messages = conversationManager.messageState.messages
                    let streamingMessage = conversationManager.streamingState.streamingMessage
                    let lastAssistantId = messages.last(where: { $0.role == .assistant })?.id
                    let lastUserId = messages.last(where: { $0.role == .user })?.id
                    let canDeleteMessage = conversationManager.conversationState.currentConversationId != nil

                    LazyVStack(spacing: 16) {
                        // Top sentinel for pagination
                        if conversationManager.paginationState.hasMore {
                            Color.clear
                                .frame(height: 1)
                                .id("pagination-sentinel")
                                .onAppear {
                                    // Trigger pagination when sentinel appears
                                    if conversationManager.paginationState.canLoadMore {
                                        Task {
                                            await conversationManager.loadMoreMessages()
                                        }
                                    }
                                }

                            // Loading indicator for pagination
                            if conversationManager.paginationState.isLoadingMore {
                                HStack {
                                    ProgressView()
                                        .controlSize(.small)
                                    Text("Loading older messages...")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                            }
                        }

                        ForEach(messages) { message in
                            messageRow(
                                for: message,
                                lastAssistantId: lastAssistantId,
                                lastUserId: lastUserId,
                                canDeleteMessage: canDeleteMessage
                            )
                        }

                        if let streamingMessage = streamingMessage {
                            MessageRow(
                                message: streamingMessage,
                                onCopy: nil,
                                onEdit: nil,
                                onRetry: nil,
                                onDelete: nil
                            )
                            .id(streamingMessage.id)
                            .opacity(0.95)
                        }
                    }
                    .padding()
                }
                .scrollDismissesKeyboard(.immediately)
                // Consolidated onChange handler - replaces duplicate handlers
                .onChange(of: conversationManager.messageState.count) { oldCount, newCount in
                    // Only auto-scroll if scroll state allows it
                    guard conversationManager.scrollState.shouldScrollOnNewContent else { return }

                    if let lastMessage = conversationManager.messageState.lastMessage {
                        withAnimation {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
                        }
                    }
                }
                .onChange(of: conversationManager.streamingState.streamingMessage?.id) { _, streamingId in
                    // Only auto-scroll if scroll state allows it
                    guard conversationManager.scrollState.shouldScrollOnNewContent else { return }

                    if let id = streamingId {
                        withAnimation {
                            proxy.scrollTo(id, anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    private func agentTypeLabel(_ type: String) -> String {
        switch type {
        case "global": return "Global Assistant"
        case "page": return "Page AI"
        case "drive": return "Drive AI"
        default: return ""
        }
    }

    /// Map color name string to SwiftUI Color
    private func colorForName(_ name: String) -> Color {
        switch name {
        case "green": return .green
        case "yellow": return .yellow
        case "orange": return .orange
        case "red": return .red
        default: return .secondary
        }
    }

    private var canSend: Bool {
        !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !conversationManager.streamingState.isStreaming
    }

    private func sendMessage() async {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        messageText = ""
        await conversationManager.sendMessage(text)

        // Refresh usage data after message is sent
        Task {
            await conversationManager.usageState.fetchUsage()

            // Also fetch AI conversation usage if we have a conversation
            if let conversationId = conversationManager.conversationState.currentConversationId {
                await conversationManager.usageState.fetchAiConversationUsage(conversationId: conversationId)
            }
        }
    }

    private func plainText(from message: Message) -> String {
        message.parts.compactMap { part -> String? in
            if case .text(let textPart) = part {
                return textPart.text
            }
            return nil
        }
        .joined(separator: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func canEdit(_ message: Message) -> Bool {
        (message.role == .user || message.role == .assistant) && !plainText(from: message).isEmpty
    }

    @ViewBuilder
    private func messageContextMenu(
        for message: Message,
        isLastAssistant: Bool,
        isLastUser: Bool,
        hasCopyAction: Bool,
        canEditMessage: Bool,
        canRetryMessage: Bool,
        canDeleteMessage: Bool
    ) -> some View {
        if hasCopyAction {
            Button {
                copyMessage(from: message)
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }

        if canEditMessage {
            Button {
                presentEdit(for: message)
            } label: {
                Label("Edit", systemImage: "square.and.pencil")
            }
        }

        if canRetryMessage && (isLastAssistant || isLastUser) {
            Button {
                Task {
                    await conversationManager.retryLastTurn()
                }
            } label: {
                Label("Retry Response", systemImage: "arrow.clockwise")
            }
        }

        if canDeleteMessage {
            Button(role: .destructive) {
                prepareToDelete(message)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func copyMessage(from message: Message) {
        let text = plainText(from: message)
        guard !text.isEmpty else { return }

        UIPasteboard.general.string = text

        let generator = UINotificationFeedbackGenerator()
        generator.notificationOccurred(.success)
    }

    private func presentEdit(for message: Message) {
        let text = plainText(from: message)
        guard !text.isEmpty else { return }

        editingContext = MessageEditContext(
            id: message.id,
            role: message.role,
            initialText: text
        )
    }

    private func handleEditSave(for context: MessageEditContext, updatedText: String) {
        let trimmed = updatedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            alertMessage = "Message cannot be empty."
            return
        }

        isSavingEdit = true

        Task {
            do {
                try await conversationManager.updateMessage(messageId: context.id, newContent: trimmed)
                await MainActor.run {
                    editingContext = nil
                    isSavingEdit = false
                }
            } catch {
                await MainActor.run {
                    alertMessage = "Failed to update message. \(error.localizedDescription)"
                    isSavingEdit = false
                }
            }
        }
    }

    @ViewBuilder
    private func messageRow(
        for message: Message,
        lastAssistantId: String?,
        lastUserId: String?,
        canDeleteMessage: Bool
    ) -> some View {
        let isLastAssistant = message.id == lastAssistantId
        let isLastUser = message.id == lastUserId
        let hasCopyAction = !plainText(from: message).isEmpty
        let canEditMessage = canEdit(message)
        let canRetryAssistant = message.role == .assistant && isLastAssistant && !conversationManager.streamingState.isStreaming
        let canRetryUser = message.role == .user && isLastUser && !conversationManager.streamingState.isStreaming
        let canRetryMessage = canRetryAssistant || canRetryUser

        if hasCopyAction || canEditMessage || canRetryMessage || canDeleteMessage {
            MessageRow(
                message: message,
                onCopy: hasCopyAction ? { copyMessage(from: message) } : nil,
                onEdit: canEditMessage ? { presentEdit(for: message) } : nil,
                onRetry: canRetryMessage ? {
                    Task {
                        await conversationManager.retryLastTurn()
                    }
                } : nil,
                onDelete: canDeleteMessage ? { prepareToDelete(message) } : nil
            )
            .id(message.id)
            .contextMenu {
                messageContextMenu(
                    for: message,
                    isLastAssistant: isLastAssistant,
                    isLastUser: isLastUser,
                    hasCopyAction: hasCopyAction,
                    canEditMessage: canEditMessage,
                    canRetryMessage: canRetryMessage,
                    canDeleteMessage: canDeleteMessage
                )
            }
        } else {
            MessageRow(
                message: message,
                onCopy: nil,
                onEdit: nil,
                onRetry: nil,
                onDelete: nil
            )
            .id(message.id)
        }
    }

    private func prepareToDelete(_ message: Message) {
        messagePendingDeletion = message
        isShowingDeleteConfirmation = true
    }

    private func performDelete(for message: Message) {
        isShowingDeleteConfirmation = false

        Task {
            do {
                try await conversationManager.deleteMessage(messageId: message.id)
                await MainActor.run {
                    if messagePendingDeletion?.id == message.id {
                        messagePendingDeletion = nil
                    }
                }
            } catch {
                await MainActor.run {
                    messagePendingDeletion = nil
                    alertMessage = "Failed to delete message. \(error.localizedDescription)"
                }
            }
        }
    }
}

private struct MessageEditContext: Identifiable {
    let id: String
    let role: MessageRole
    let initialText: String

    var title: String {
        role == .user ? "Edit Message" : "Edit Response"
    }
}

private struct MessageEditSheet: View {
    let context: MessageEditContext
    let isSaving: Bool
    let onCancel: () -> Void
    let onSave: (String) -> Void

    @State private var text: String

    init(
        context: MessageEditContext,
        isSaving: Bool,
        onCancel: @escaping () -> Void,
        onSave: @escaping (String) -> Void
    ) {
        self.context = context
        self.isSaving = isSaving
        self.onCancel = onCancel
        self.onSave = onSave
        _text = State(initialValue: context.initialText)
    }

    var body: some View {
        NavigationStack {
            VStack {
                TextEditor(text: $text)
                    .scrollContentBackground(.hidden)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(Color(.systemGray4), lineWidth: 1)
                    )
                    .padding()
            }
            .navigationTitle(context.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(text)
                    }
                    .disabled(isSaving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isSaving)
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
