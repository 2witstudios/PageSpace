//
//  ConversationManager.swift
//  PageSpace
//
//  Created on 2025-11-02.
//  Central manager for conversation state (similar to web app's GlobalChatContext)
//

import Foundation
import Combine

/// Centralized conversation state manager
/// Single source of truth for current conversation and messages
/// Matches web app's GlobalChatContext pattern
@MainActor
class ConversationManager: ObservableObject {
    static let shared = ConversationManager()

    // MARK: - Published State (Single Source of Truth)

    /// Current conversation ID being displayed
    @Published var currentConversationId: String?

    /// Track the loaded conversation (for display)
    @Published var currentConversation: Conversation?

    /// Track the AGENT user selected (for creating new conversations)
    /// This is set by AgentService when user picks an agent
    @Published var selectedAgentType: String? = nil  // "global", pageId, or driveId
    @Published var selectedAgentContextId: String? = nil  // nil for global, pageId/driveId otherwise

    /// Completed messages for the current conversation (immutable history)
    @Published private(set) var messages: [Message] = []

    /// Currently streaming message (separate from completed messages)
    @Published private(set) var streamingMessage: Message?

    /// Loading state for conversation switching
    @Published var isLoadingConversation = false

    /// Streaming state for message sending
    @Published var isStreaming = false

    /// Error message if any
    @Published var error: String?

    // MARK: - AI Provider/Model Selection

    /// Currently selected AI provider (e.g., "pagespace", "openrouter", "google")
    @Published var selectedProvider: String = "pagespace"

    /// Currently selected AI model (e.g., "glm-4.5-air", "gpt-4o")
    @Published var selectedModel: String = "glm-4.5-air"

    /// Provider settings from backend (configuration status per provider)
    @Published var providerSettings: AISettings?

    /// Agent-specific overrides from page/drive configuration
    /// When set, these override the user's default provider/model
    @Published var agentConfigOverrides: AgentConfig?

    // MARK: - Services

    private let conversationService = ConversationService.shared
    private let aiService = AIService.shared

    // MARK: - Internal State (Not Published)

    /// Internal accumulator for building streaming message
    private var streamingMessageBuilder: StreamingMessage?

    /// Throttle to batch rapid stream updates (prevents SwiftUI frame overload)
    private let streamThrottle = StreamThrottle(interval: 0.05) // 50ms batching

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
            self.providerSettings = settings
            self.selectedProvider = settings.currentProvider
            self.selectedModel = settings.currentModel

            // Auto-correct if user has restricted model selected without proper tier
            if selectedProvider == "pagespace" && selectedModel == "glm-4.6" {
                let userTier = settings.userSubscriptionTier
                if userTier != "pro" && userTier != "business" {
                    // Free user has restricted model selected, reset to default
                    print("⚠️ Free user has Pro model selected, resetting to glm-4.5-air")
                    self.selectedModel = "glm-4.5-air"

                    // Optionally persist the correction to backend
                    do {
                        _ = try await aiService.updateSettings(provider: selectedProvider, model: "glm-4.5-air")
                        print("✅ Auto-corrected model to glm-4.5-air")
                    } catch {
                        print("⚠️ Failed to persist auto-correction: \(error)")
                    }
                }
            }

            print("✅ Loaded provider settings: \(selectedProvider)/\(selectedModel)")
        } catch {
            print("❌ Failed to load provider settings: \(error)")
        }
    }

    /// Update provider selection
    func updateProvider(_ provider: String, model: String) async {
        self.selectedProvider = provider
        self.selectedModel = model

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
            agentConfigOverrides = nil
            return
        }

        do {
            let config = try await aiService.getAgentConfig(pageId: contextId)
            self.agentConfigOverrides = config

            // Apply overrides if present
            if let provider = config.aiProvider {
                self.selectedProvider = provider
            }
            if let model = config.aiModel {
                self.selectedModel = model
            }

            print("✅ Loaded agent config overrides for page \(contextId)")
        } catch {
            print("⚠️ Failed to load agent config: \(error)")
            agentConfigOverrides = nil
        }
    }

    /// Get the active provider/model (considers overrides)
    func getActiveProviderModel() -> (provider: String, model: String) {
        let provider = agentConfigOverrides?.aiProvider ?? selectedProvider
        let model = agentConfigOverrides?.aiModel ?? selectedModel
        return (provider, model)
    }

    /// Check if a provider is configured and available
    func isProviderConfigured(_ provider: String) -> Bool {
        guard let settings = providerSettings else { return false }
        return settings.isProviderConfigured(provider)
    }

    // MARK: - Load Conversation (Atomic Operation)

    /// Load a specific conversation's messages
    /// This is an atomic operation - old messages are cleared before new ones load
    func loadConversation(_ conversation: Conversation) async {
        // Guard against redundant loads
        guard conversation.id != currentConversationId else {
            print("ℹ️ Conversation \(conversation.id) already loaded")
            return
        }

        print("🟢 ConversationManager.loadConversation - loading: \(conversation.displayTitle)")

        // Capture the conversation ID we're loading for race condition protection
        let loadingConversationId = conversation.id

        isLoadingConversation = true
        error = nil

        // CRITICAL: Clear old messages immediately
        messages = []
        currentConversation = conversation
        currentConversationId = conversation.id

        do {
            // Fetch messages from API
            let response = try await aiService.loadMessages(conversationId: conversation.id)

            // Verify the response still matches the currently selected conversation
            // This prevents race conditions when rapidly switching conversations:
            // - User clicks conversation A → loadConversation(A) starts
            // - Before A's API returns, user clicks conversation B → loadConversation(B) starts
            // - If A returns first, we discard it because currentConversationId != A's ID
            if currentConversationId == loadingConversationId {
                messages = response.messages

                // Update selected agent to match loaded conversation
                selectedAgentType = conversation.type ?? "global"
                selectedAgentContextId = conversation.contextId

                // Load agent-specific configuration overrides for page agents
                if let contextType = conversation.type, let contextId = conversation.contextId {
                    await loadAgentConfig(contextType: contextType, contextId: contextId)
                }

                print("✅ Loaded \(messages.count) messages for conversation: \(conversation.displayTitle)")
            } else {
                print("⚠️ Discarding stale response for \(conversation.displayTitle) - user switched to different conversation")
            }
        } catch {
            // Only set error if still on the same conversation
            if currentConversationId == loadingConversationId {
                self.error = "Failed to load conversation: \(error.localizedDescription)"
                print("❌ Failed to load conversation \(conversation.id): \(error)")
            } else {
                print("⚠️ Discarding error for \(conversation.displayTitle) - user switched to different conversation")
            }
        }

        isLoadingConversation = false
    }

    // MARK: - Create New Conversation

    /// Start a new conversation (clears current state)
    func createNewConversation() {
        print("🆕 ConversationManager.createNewConversation - agent: \(selectedAgentType ?? "unknown")")
        currentConversationId = nil
        currentConversation = nil
        messages = []
        streamingMessage = nil
        streamingMessageBuilder = nil
        streamThrottle.cancel()
        error = nil

        // Clear agent overrides and reset to user defaults
        agentConfigOverrides = nil
        if let settings = providerSettings {
            selectedProvider = settings.currentProvider
            selectedModel = settings.currentModel
        }
    }

    // MARK: - Send Message

    /// Send a message in the current conversation
    func sendMessage(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard !isStreaming else {
            print("⚠️ Ignoring send request while streaming is active")
            return
        }

        print("📤 ConversationManager.sendMessage - text: \(trimmed.prefix(50))...")

        // Create user message
        let userMessage = Message(
            role: .user,
            parts: [.text(TextPart(text: trimmed))]
        )

        // Add to UI immediately
        messages.append(userMessage)

        do {
            // Ensure we have a conversation to stream against
            let conversationId = try await ensureConversation()
            let history = messages

            startStreaming(conversationId: conversationId, history: history)

            // Wait for stream to finish so callers can await completion
            await streamTask?.value
        } catch {
            self.error = "Failed to send message: \(error.localizedDescription)"
            print("❌ Failed to send message: \(error)")

            isStreaming = false
            streamingMessage = nil
            streamingMessageBuilder = nil
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
        streamThrottle.cancel()
        streamingMessage = nil
        streamingMessageBuilder = nil
        isStreaming = false
    }

    // MARK: - Streaming Helpers

    private func ensureConversation() async throws -> String {
        if let conversationId = currentConversationId {
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

        currentConversationId = newConversation.id
        currentConversation = newConversation

        print("✅ Created \(type) conversation: \(newConversation.id) with contextId: \(contextId ?? "nil")")

        return newConversation.id
    }

    private func startStreaming(conversationId: String, history: [Message]) {
        // Cancel any existing stream to avoid overlapping updates
        streamTask?.cancel()
        streamTask = nil
        streamThrottle.cancel()
        streamingMessage = nil
        streamingMessageBuilder = nil

        let assistantMessageId = UUID().uuidString
        streamingMessageBuilder = StreamingMessage(id: assistantMessageId, role: .assistant)

        isStreaming = true
        error = nil

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

                streamThrottle.flush()

                if !wasCancelled, let builder = streamingMessageBuilder {
                    messages.append(builder.toMessage())
                }

                if !wasCancelled {
                    print("✅ Message sent successfully")
                }

            } catch is CancellationError {
                print("🛑 Stream cancelled")
            } catch {
                self.error = "Failed to send message: \(error.localizedDescription)"
                print("❌ Failed to send message: \(error)")

                // Clear incomplete streaming message on error
                streamThrottle.cancel()
                streamingMessage = nil
                streamingMessageBuilder = nil
            }

            isStreaming = false
            streamingMessage = nil
            streamingMessageBuilder = nil
            streamTask = nil
        }
    }

    // MARK: - Message Mutations

    /// Update existing message content on the backend and in local state
    func updateMessage(messageId: String, newContent: String) async throws {
        guard let conversationId = currentConversationId else {
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

        if let index = messages.firstIndex(where: { $0.id == messageId }) {
            var updated = messages[index]
            updated.parts = [.text(TextPart(text: newContent))]
            updated.editedAt = Date()
            messages[index] = updated
        } else if streamingMessage?.id == messageId {
            var updated = streamingMessage
            updated?.parts = [.text(TextPart(text: newContent))]
            updated?.editedAt = Date()
            streamingMessage = updated
        }
    }

    /// Delete a message from the backend and remove it locally
    func deleteMessage(messageId: String) async throws {
        guard let conversationId = currentConversationId else {
            throw NSError(
                domain: "ConversationManager",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "No active conversation to delete from"]
            )
        }

        try await aiService.deleteMessage(conversationId: conversationId, messageId: messageId)

        messages.removeAll { $0.id == messageId }

        if streamingMessage?.id == messageId {
            streamingMessage = nil
        }
    }

    /// Retry the last conversational turn by re-running from the most recent user message
    func retryLastTurn() async {
        guard !isStreaming else {
            print("⚠️ Cannot retry while another stream is active")
            return
        }
        guard let conversationId = currentConversationId else {
            print("⚠️ Cannot retry without an active conversation ID")
            return
        }
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
                self.error = "Failed to retry assistant message: \(error.localizedDescription)"
                print("❌ Failed to delete assistant message(s) before retry: \(error)")
                return
            }

            let assistantIds = Set(assistantMessages.map { $0.id })
            messages.removeAll { assistantIds.contains($0.id) }
        }

        guard messages.last?.role == .user else {
            print("⚠️ After cleaning assistant replies, last message is not user. Aborting retry.")
            return
        }

        let history = messages
        error = nil
        startStreaming(conversationId: conversationId, history: history)
        await streamTask?.value
    }

    // MARK: - Stream Processing

    private func processStreamChunk(_ chunk: StreamChunk) {
        guard var builder = streamingMessageBuilder else { return }

        // Accumulate chunk into internal builder
        switch chunk.type {
        case "text-delta":
            if let text = chunk.delta {
                let isFirstTextChunk = builder.parts.isEmpty
                builder.appendText(text)
                streamingMessageBuilder = builder

                if isFirstTextChunk {
                    // Bypass throttle for first chunk (instant feedback, prevents empty bubble)
                    streamingMessage = builder.toMessage()
                } else {
                    // Use throttle for subsequent chunks (batching for performance)
                    scheduleStreamingUpdate()
                }
            }

        case let type where type.hasPrefix("tool-"):
            // Handle any tool type (e.g., "tool-list_drives", "tool-read_page")
            // Tool data is flat at the top level (matches Vercel AI SDK v5 format)

            if let toolCallId = chunk.toolCallId, let toolName = chunk.toolName {
                // Tool call with input (tool-input-* events)
                // Use updateOrAddTool to prevent duplicates from multiple events
                let toolPart = ToolPart(
                    type: chunk.type,
                    toolCallId: toolCallId,
                    toolName: toolName,
                    input: chunk.input != nil ? (chunk.input!.value as? [String: AnyCodable]) : nil,
                    output: nil,
                    state: .inputAvailable
                )
                builder.updateOrAddTool(toolPart)
                streamingMessageBuilder = builder
                scheduleStreamingUpdate()
            } else if let toolCallId = chunk.toolCallId, chunk.output != nil {
                // Tool result (tool-output-available)
                builder.updateTool(
                    toolCallId: toolCallId,
                    output: chunk.output,
                    state: chunk.isError == true ? .outputError : .outputAvailable
                )
                streamingMessageBuilder = builder
                scheduleStreamingUpdate()
            }

        case "finish":
            builder.isComplete = true
            streamingMessageBuilder = builder
            // Flush immediately on finish to show complete message
            streamThrottle.flush()

        default:
            break
        }
    }

    /// Schedules a throttled update of the streaming message in the UI
    /// Updates are batched at 50ms intervals to prevent SwiftUI frame overload
    private func scheduleStreamingUpdate() {
        streamThrottle.execute { [weak self] in
            guard let self = self else { return }

            // Build complete message from accumulator and publish atomically
            if let builder = self.streamingMessageBuilder {
                self.streamingMessage = builder.toMessage()
            }
        }
    }
}

// MARK: - Streaming Message Helper
// NOTE: StreamingMessage is defined in Message.swift
