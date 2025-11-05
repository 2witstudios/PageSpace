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
                        let lastAssistantId = conversationManager.messages.last(where: { $0.role == .assistant })?.id
                        let lastUserId = conversationManager.messages.last(where: { $0.role == .user })?.id

                        LazyVStack(spacing: 16) {
                            // Completed messages
                            ForEach(conversationManager.messages) { message in
                                let isLastAssistant = message.id == lastAssistantId
                                let hasCopyAction = !plainText(from: message).isEmpty
                                let canEditMessage = canEdit(message)
                                let isLastUser = message.id == lastUserId
                                let canRetryAssistant = message.role == .assistant && isLastAssistant && !conversationManager.isStreaming
                                let canRetryUser = message.role == .user && isLastUser && !conversationManager.isStreaming
                                let canRetryMessage = canRetryAssistant || canRetryUser
                                if hasCopyAction || canEditMessage || canRetryMessage {
                                    MessageRow(
                                        message: message,
                                        onCopy: hasCopyAction ? { copyMessage(from: message) } : nil,
                                        onEdit: canEditMessage ? { presentEdit(for: message) } : nil,
                                        onRetry: canRetryMessage ? {
                                            Task {
                                                await conversationManager.retryLastTurn()
                                            }
                                        } : nil
                                    )
                                    .id(message.id)
                                    .contextMenu {
                                        messageContextMenu(
                                            for: message,
                                            isLastAssistant: isLastAssistant,
                                            isLastUser: isLastUser,
                                            hasCopyAction: hasCopyAction,
                                            canEditMessage: canEditMessage,
                                            canRetryMessage: canRetryMessage
                                        )
                                    }
                                } else {
                                    MessageRow(
                                        message: message,
                                        onCopy: nil,
                                        onEdit: nil,
                                        onRetry: nil
                                    )
                                    .id(message.id)
                                }
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
                    .focused($isTextFieldFocused)
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
                    withAnimation(.easeInOut(duration: 0.3)) {
                        isSidebarOpen.toggle()
                    }
                }) {
                    VStack(spacing: 2) {
                        if let conversation = conversationManager.currentConversation {
                            // Show conversation title
                            Text(conversation.displayTitle)
                                .font(.headline)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            // Optionally show agent type in small text
                            Text(agentTypeLabel(conversation.type ?? "global"))
                                .font(.caption2)
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        } else if let agent = agentService.selectedAgent {
                            // New conversation - show agent name
                            Text(agent.title)
                                .font(.headline)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            if let subtitle = agent.subtitle {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                        } else {
                            // Fallback
                            Text("Chat")
                                .font(.headline)
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
        canRetryMessage: Bool
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
