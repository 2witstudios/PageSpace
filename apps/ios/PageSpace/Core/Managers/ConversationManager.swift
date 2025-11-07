//
//  ConversationManager.swift
//  PageSpace
//
//  Created on 2025-11-02.
//  Refactored on 2025-11-05 to use state objects for performance optimization
//  Central manager for conversation state (similar to web app's GlobalChatContext)
//

import Foundation
import Combine

/// Centralized conversation state manager
/// Delegates to specialized state objects to prevent unnecessary view rebuilds
/// Matches web app's GlobalChatContext pattern
@MainActor
class ConversationManager: ObservableObject {
    static let shared = ConversationManager()

    // MARK: - State Objects (New Architecture)

    /// Message state (completed messages array)
    let messageState = MessageState()

    /// Streaming state (streaming message and throttle logic)
    let streamingState = StreamingState()

    /// Conversation state (metadata and loading)
    let conversationState = ConversationState()

    /// Settings state (AI provider and model configuration)
    let settingsState = SettingsState()

    /// Pagination state (cursor and pagination metadata)
    let paginationState = PaginationState()

    /// Scroll state (scroll position tracking)
    let scrollState = ScrollState()

    /// Usage state (AI usage and rate limiting)
    let usageState = UsageState()

    // MARK: - Backward Compatibility (Deprecated - Will be removed in Phase 7)

    /// Track the AGENT user selected (for creating new conversations)
    /// This is set by AgentService when user picks an agent
    @Published var selectedAgentType: String? = nil  // "global", pageId, or driveId
    @Published var selectedAgentContextId: String? = nil  // nil for global, pageId/driveId otherwise

    /// Deprecated: Use messageState.messages instead
    @available(*, deprecated, message: "Use messageState.messages instead")
    var messages: [Message] {
        get { messageState.messages }
        set { messageState.setMessages(newValue) }
    }

    /// Deprecated: Use streamingState.streamingMessage instead
    @available(*, deprecated, message: "Use streamingState.streamingMessage instead")
    var streamingMessage: Message? {
        streamingState.streamingMessage
    }

    /// Deprecated: Use streamingState.isStreaming instead
    @available(*, deprecated, message: "Use streamingState.isStreaming instead")
    var isStreaming: Bool {
        streamingState.isStreaming
    }

    /// Deprecated: Use conversationState.currentConversationId instead
    @available(*, deprecated, message: "Use conversationState.currentConversationId instead")
    var currentConversationId: String? {
        get { conversationState.currentConversationId }
        set { conversationState.setConversationId(newValue) }
    }

    /// Deprecated: Use conversationState.currentConversation instead
    @available(*, deprecated, message: "Use conversationState.currentConversation instead")
    var currentConversation: Conversation? {
        conversationState.currentConversation
    }

    /// Deprecated: Use conversationState.isLoadingConversation instead
    @available(*, deprecated, message: "Use conversationState.isLoadingConversation instead")
    var isLoadingConversation: Bool {
        conversationState.isLoadingConversation
    }

    /// Deprecated: Use conversationState.error instead
    @available(*, deprecated, message: "Use conversationState.error instead")
    var error: String? {
        conversationState.error
    }

    /// Deprecated: Use settingsState.selectedProvider instead
    @available(*, deprecated, message: "Use settingsState.selectedProvider instead")
    var selectedProvider: String {
        get { settingsState.selectedProvider }
        set { settingsState.setProvider(newValue) }
    }

    /// Deprecated: Use settingsState.selectedModel instead
    @available(*, deprecated, message: "Use settingsState.selectedModel instead")
    var selectedModel: String {
        get { settingsState.selectedModel }
        set { settingsState.setModel(newValue) }
    }

    /// Deprecated: Use settingsState.providerSettings instead
    @available(*, deprecated, message: "Use settingsState.providerSettings instead")
    var providerSettings: AISettings? {
        settingsState.providerSettings
    }

    /// Deprecated: Use settingsState.agentConfigOverrides instead
    @available(*, deprecated, message: "Use settingsState.agentConfigOverrides instead")
    var agentConfigOverrides: AgentConfig? {
        settingsState.agentConfigOverrides
    }

    // MARK: - Services

    private let conversationService = ConversationService.shared
    private let aiService = AIService.shared

    // MARK: - Internal State (Not Published)

    /// Active streaming task (for cancellation support)
    private var streamTask: Task<Void, Never>?

    private init() {
        // Load provider settings on initialization
        Task {
            await loadProviderSettings()
        }
    }

    // MARK: - Provider Settings

    /// Load provider settings from backend
    func loadProviderSettings() async {
        do {
            let settings = try await aiService.getSettings()
            settingsState.setProviderSettings(settings)
            settingsState.setProvider(settings.currentProvider)
            settingsState.setModel(settings.currentModel)

            // Auto-correct if user has restricted model selected without proper tier
            if settingsState.selectedProvider == "pagespace" && settingsState.selectedModel == "glm-4.6" {
                let userTier = settings.userSubscriptionTier
                if userTier != "pro" && userTier != "business" {
                    // Free user has restricted model selected, reset to default
                    print("⚠️ Free user has Pro model selected, resetting to glm-4.5-air")
                    settingsState.setModel("glm-4.5-air")

                    // Optionally persist the correction to backend
                    do {
                        _ = try await aiService.updateSettings(provider: settingsState.selectedProvider, model: "glm-4.5-air")
                        print("✅ Auto-corrected model to glm-4.5-air")
                    } catch {
                        print("⚠️ Failed to persist auto-correction: \(error)")
                    }
                }
            }

            print("✅ Loaded provider settings: \(settingsState.selectedProvider)/\(settingsState.selectedModel)")
        } catch {
            print("❌ Failed to load provider settings: \(error)")
        }
    }

    /// Update provider selection
    func updateProvider(_ provider: String, model: String) async {
        settingsState.setProvider(provider)
        settingsState.setModel(model)

        // Optionally persist to backend
        do {
            _ = try await aiService.updateSettings(provider: provider, model: model)
            print("✅ Updated provider settings: \(provider)/\(model)")
        } catch {
            print("⚠️ Failed to persist provider settings: \(error)")
        }
    }

    /// Load agent-specific configuration overrides for a page/drive
    func loadAgentConfig(contextType: String, contextId: String) async {
        // Only page agents support custom configuration
        guard contextType == "page" else {
            settingsState.setAgentConfigOverrides(nil)
            return
        }

        do {
            let config = try await aiService.getAgentConfig(pageId: contextId)
            settingsState.setAgentConfigOverrides(config)

            // Apply overrides if present
            if let provider = config.aiProvider {
                settingsState.setProvider(provider)
            }
            if let model = config.aiModel {
                settingsState.setModel(model)
            }

            print("✅ Loaded agent config overrides for page \(contextId)")
        } catch {
            print("⚠️ Failed to load agent config: \(error)")
            settingsState.setAgentConfigOverrides(nil)
        }
    }

    /// Get the active provider/model (considers overrides)
    func getActiveProviderModel() -> (provider: String, model: String) {
        let provider = settingsState.agentConfigOverrides?.aiProvider ?? settingsState.selectedProvider
        let model = settingsState.agentConfigOverrides?.aiModel ?? settingsState.selectedModel
        return (provider, model)
    }

    /// Check if a provider is configured and available
    func isProviderConfigured(_ provider: String) -> Bool {
        guard let settings = settingsState.providerSettings else { return false }
        return settings.isProviderConfigured(provider)
    }

    // MARK: - Load Conversation (Atomic Operation)

    /// Load a specific conversation's messages
    /// This is an atomic operation - old messages are cleared before new ones load
    func loadConversation(_ conversation: Conversation) async {
        // Guard against redundant loads
        guard conversation.id != conversationState.currentConversationId else {
            print("ℹ️ Conversation \(conversation.id) already loaded")
            return
        }

        print("🟢 ConversationManager.loadConversation - loading: \(conversation.displayTitle)")

        // Capture the conversation ID we're loading for race condition protection
        let loadingConversationId = conversation.id

        conversationState.setLoading(true)

        // CRITICAL: Clear old messages immediately
        messageState.clear()
        conversationState.setConversation(conversation)

        // Reset pagination state for new conversation
        paginationState.reset()

        // Reset scroll state
        scrollState.reset()

        do {
            // Fetch messages from API
            let response = try await aiService.loadMessages(conversationId: conversation.id)

            // Verify the response still matches the currently selected conversation
            // This prevents race conditions when rapidly switching conversations:
            // - User clicks conversation A → loadConversation(A) starts
            // - Before A's API returns, user clicks conversation B → loadConversation(B) starts
            // - If A returns first, we discard it because currentConversationId != A's ID
            if conversationState.currentConversationId == loadingConversationId {
                messageState.setMessages(response.messages)

                // Update pagination state
                if let pagination = response.pagination {
                    paginationState.updatePagination(
                        cursor: pagination.nextCursor,
                        hasMore: pagination.hasMore
                    )
                }

                // Update selected agent to match loaded conversation
                selectedAgentType = conversation.type ?? "global"
                selectedAgentContextId = conversation.contextId

                // Load agent-specific configuration overrides for page agents
                if let contextType = conversation.type, let contextId = conversation.contextId {
                    await loadAgentConfig(contextType: contextType, contextId: contextId)
                }

                print("✅ Loaded \(messageState.count) messages for conversation: \(conversation.displayTitle)")
            } else {
                print("⚠️ Discarding stale response for \(conversation.displayTitle) - user switched to different conversation")
            }
        } catch {
            // Only set error if still on the same conversation
            if conversationState.currentConversationId == loadingConversationId {
                conversationState.setError("Failed to load conversation: \(error.localizedDescription)")
                print("❌ Failed to load conversation \(conversation.id): \(error)")
            } else {
                print("⚠️ Discarding error for \(conversation.displayTitle) - user switched to different conversation")
            }
        }

        conversationState.setLoading(false)
    }

    // MARK: - Pagination

    /// Load more messages (backwards pagination)
    func loadMoreMessages() async {
        guard paginationState.canLoadMore else {
            print("ℹ️ Cannot load more messages: hasMore=\(paginationState.hasMore), isLoading=\(paginationState.isLoadingMore)")
            return
        }

        guard let conversationId = conversationState.currentConversationId else {
            print("⚠️ Cannot load more messages without an active conversation")
            return
        }

        print("🔄 Loading more messages with cursor: \(paginationState.cursor ?? "nil")")

        paginationState.setLoading(true)

        do {
            let response = try await aiService.loadMessages(
                conversationId: conversationId,
                limit: paginationState.limit,
                cursor: paginationState.cursor
            )

            // Prepend older messages to the beginning
            messageState.prepend(response.messages)

            // Update pagination state
            if let pagination = response.pagination {
                paginationState.updatePagination(
                    cursor: pagination.nextCursor,
                    hasMore: pagination.hasMore
                )
            }

            print("✅ Loaded \(response.messages.count) more messages (total: \(messageState.count))")
        } catch {
            paginationState.setError("Failed to load more messages: \(error.localizedDescription)")
            print("❌ Failed to load more messages: \(error)")
        }
    }

    // MARK: - Create New Conversation

    /// Start a new conversation (clears current state)
    func createNewConversation() {
        print("🆕 ConversationManager.createNewConversation - agent: \(selectedAgentType ?? "unknown")")

        // Clear all state
        conversationState.clear()
        messageState.clear()
        streamingState.clear()
        paginationState.reset()
        scrollState.reset()

        // Clear agent overrides and reset to user defaults
        settingsState.setAgentConfigOverrides(nil)
        if let settings = settingsState.providerSettings {
            settingsState.setProvider(settings.currentProvider)
            settingsState.setModel(settings.currentModel)
        }
    }

    // MARK: - Send Message

    /// Send a message in the current conversation
    func sendMessage(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard !streamingState.isStreaming else {
            print("⚠️ Ignoring send request while streaming is active")
            return
        }

        print("📤 ConversationManager.sendMessage - text: \(trimmed.prefix(50))...")

        // Enable auto-scroll when sending a message
        scrollState.enableAutoScroll()

        // Create user message
        let userMessage = Message(
            role: .user,
            parts: [.text(TextPart(text: trimmed))]
        )

        // Add to UI immediately
        messageState.append(userMessage)

        do {
            // Ensure we have a conversation to stream against
            let conversationId = try await ensureConversation()
            let history = messageState.messages

            startStreaming(conversationId: conversationId, history: history)

            // Wait for stream to finish so callers can await completion
            await streamTask?.value
        } catch {
            conversationState.setError("Failed to send message: \(error.localizedDescription)")
            print("❌ Failed to send message: \(error)")

            streamingState.cancelStreaming()
            streamTask = nil
        }
    }

    // MARK: - Stop Streaming

    /// Stop the current streaming operation
    func stopStreaming() {
        print("🛑 ConversationManager.stopStreaming - cancelling active stream")

        // Cancel the active streaming task
        streamTask?.cancel()
        streamTask = nil

        // Clean up streaming state
        streamingState.cancelStreaming()
    }

    // MARK: - Streaming Helpers

    private func ensureConversation() async throws -> String {
        if let conversationId = conversationState.currentConversationId {
            return conversationId
        }

        let type = selectedAgentType ?? "global"
        let contextId = selectedAgentContextId

        print("ℹ️ Creating new \(type.uppercased()) conversation with contextId: \(contextId ?? "nil")")

        let newConversation = try await conversationService.createConversation(
            title: nil,
            type: type,
            contextId: contextId
        )

        conversationState.setConversation(newConversation)

        print("✅ Created \(type) conversation: \(newConversation.id) with contextId: \(contextId ?? "nil")")

        return newConversation.id
    }

    private func startStreaming(conversationId: String, history: [Message]) {
        // Cancel any existing stream to avoid overlapping updates
        streamTask?.cancel()
        streamTask = nil
        streamingState.clear()

        let assistantMessageId = UUID().uuidString
        streamingState.startStreaming(id: assistantMessageId, role: .assistant)

        conversationState.clearError()

        streamTask = Task { @MainActor [history] in
            var wasCancelled = false

            do {
                let (provider, model) = getActiveProviderModel()

                let stream = aiService.sendMessage(
                    conversationId: conversationId,
                    messages: history,
                    provider: provider,
                    model: model
                )

                for try await chunk in stream {
                    if Task.isCancelled {
                        print("🛑 Stream cancelled by user")
                        wasCancelled = true
                        break
                    }
                    processStreamChunk(chunk)
                }

                if !wasCancelled, let completedMessage = streamingState.completeStreaming() {
                    messageState.append(completedMessage)
                }

                if !wasCancelled {
                    print("✅ Message sent successfully")
                }

            } catch is CancellationError {
                print("🛑 Stream cancelled")
            } catch {
                conversationState.setError("Failed to send message: \(error.localizedDescription)")
                print("❌ Failed to send message: \(error)")

                // Clear incomplete streaming message on error
                streamingState.cancelStreaming()
            }

            streamTask = nil
        }
    }

    // MARK: - Message Mutations

    /// Update existing message content on the backend and in local state
    func updateMessage(messageId: String, newContent: String) async throws {
        guard let conversationId = conversationState.currentConversationId else {
            throw NSError(
                domain: "ConversationManager",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "No active conversation to update"]
            )
        }

        try await aiService.editMessage(
            conversationId: conversationId,
            messageId: messageId,
            content: newContent
        )

        if let message = messageState.getMessage(id: messageId) {
            var updated = message
            updated.parts = [.text(TextPart(text: newContent))]
            updated.editedAt = Date()
            messageState.update(updated)
        }
    }

    /// Delete a message from the backend and remove it locally
    func deleteMessage(messageId: String) async throws {
        guard let conversationId = conversationState.currentConversationId else {
            throw NSError(
                domain: "ConversationManager",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "No active conversation to delete from"]
            )
        }

        try await aiService.deleteMessage(conversationId: conversationId, messageId: messageId)

        messageState.delete(id: messageId)
    }

    /// Retry the last conversational turn by re-running from the most recent user message
    func retryLastTurn() async {
        guard !streamingState.isStreaming else {
            print("⚠️ Cannot retry while another stream is active")
            return
        }
        guard let conversationId = conversationState.currentConversationId else {
            print("⚠️ Cannot retry without an active conversation ID")
            return
        }

        let messages = messageState.messages
        guard let lastUserIndex = messages.lastIndex(where: { $0.role == .user }) else {
            print("⚠️ Cannot retry without a user message in history")
            return
        }

        let trailingMessages = messages.suffix(from: messages.index(after: lastUserIndex))
        let assistantMessages = trailingMessages.filter { $0.role == .assistant }

        if !assistantMessages.isEmpty {
            do {
                for message in assistantMessages {
                    try await aiService.deleteMessage(
                        conversationId: conversationId,
                        messageId: message.id
                    )
                }
            } catch {
                conversationState.setError("Failed to retry assistant message: \(error.localizedDescription)")
                print("❌ Failed to delete assistant message(s) before retry: \(error)")
                return
            }

            let assistantIds = Set(assistantMessages.map { $0.id })
            messageState.deleteMultiple(ids: assistantIds)
        }

        guard messageState.lastMessage?.role == .user else {
            print("⚠️ After cleaning assistant replies, last message is not user. Aborting retry.")
            return
        }

        let history = messageState.messages
        conversationState.clearError()

        // Enable auto-scroll for retry
        scrollState.enableAutoScroll()

        startStreaming(conversationId: conversationId, history: history)
        await streamTask?.value
    }

    // MARK: - Stream Processing

    private func processStreamChunk(_ chunk: StreamChunk) {
        // Accumulate chunk into StreamingState
        switch chunk.type {
        case "text-delta":
            if let text = chunk.delta {
                // Check if this is the first text chunk for immediate feedback
                let isFirstTextChunk = streamingState.streamingMessage?.parts.isEmpty ?? true
                streamingState.appendText(text, immediate: isFirstTextChunk)
            }

        case let type where type.hasPrefix("tool-"):
            // Handle any tool type (e.g., "tool-list_drives", "tool-read_page")
            // Tool data is flat at the top level (matches Vercel AI SDK v5 format)

            if let toolCallId = chunk.toolCallId, let toolName = chunk.toolName {
                // Tool call with input (tool-input-* events)
                let toolPart = ToolPart(
                    type: chunk.type,
                    toolCallId: toolCallId,
                    toolName: toolName,
                    input: chunk.input != nil ? (chunk.input!.value as? [String: AnyCodable]) : nil,
                    output: nil,
                    state: .inputAvailable
                )
                streamingState.updateTool(toolPart)
            } else if let toolCallId = chunk.toolCallId, chunk.output != nil {
                // Tool result (tool-output-available)
                streamingState.updateToolOutput(
                    toolCallId: toolCallId,
                    output: chunk.output,
                    state: chunk.isError == true ? .outputError : .outputAvailable
                )
            }

        case "finish":
            // Streaming will be completed in startStreaming after loop exits
            break

        default:
            break
        }
    }
}

// MARK: - Streaming Message Helper
// NOTE: StreamingMessage is defined in Message.swift
