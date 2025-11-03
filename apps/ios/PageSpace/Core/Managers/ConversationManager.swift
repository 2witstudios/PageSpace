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
            print("✅ Loaded provider settings: \(settings.currentProvider)/\(settings.currentModel)")
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
        guard !text.isEmpty else { return }

        print("📤 ConversationManager.sendMessage - text: \(text.prefix(50))...")

        // Create user message
        let userMessage = Message(
            role: .user,
            parts: [.text(TextPart(text: text))]
        )

        // Add to UI immediately
        messages.append(userMessage)

        // Create streaming message builder for assistant
        let assistantMessageId = UUID().uuidString
        streamingMessageBuilder = StreamingMessage(id: assistantMessageId, role: .assistant)

        isStreaming = true
        error = nil

        do {
            // Auto-create conversation if needed (for new conversations)
            var conversationId = currentConversationId

            if conversationId == nil {
                // Use selected agent info to determine conversation type
                let type = selectedAgentType ?? "global"
                let contextId = selectedAgentContextId

                print("ℹ️ Creating new \(type.uppercased()) conversation with contextId: \(contextId ?? "nil")")

                // Don't set a title - let backend auto-generate from first message
                let newConversation = try await conversationService.createConversation(
                    title: nil,
                    type: type,
                    contextId: contextId
                )
                conversationId = newConversation.id
                currentConversationId = conversationId
                currentConversation = newConversation
                print("✅ Created \(type) conversation: \(conversationId!) with contextId: \(contextId ?? "nil")")
            }

            guard let finalConversationId = conversationId else {
                throw NSError(
                    domain: "ConversationManager",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to get or create conversation ID"]
                )
            }

            // Stream message (wrapped in Task for cancellation support)
            streamTask = Task {
                do {
                    // Get active provider/model (considers agent overrides)
                    let (provider, model) = getActiveProviderModel()

                    let stream = aiService.sendMessage(
                        conversationId: finalConversationId,
                        messages: messages,
                        provider: provider,
                        model: model
                    )

                    for try await chunk in stream {
                        // Check if task was cancelled
                        if Task.isCancelled {
                            print("🛑 Stream cancelled by user")
                            break
                        }
                        processStreamChunk(chunk)
                    }

                    // Flush any pending throttled updates (ensures final UI update)
                    streamThrottle.flush()

                    // Move streaming message to completed messages
                    // Use builder (source of truth) instead of streamingMessage (throttled snapshot)
                    // to ensure we capture all chunks, including any pending in the throttle
                    if let builder = streamingMessageBuilder {
                        messages.append(builder.toMessage())
                    }

                    print("✅ Message sent successfully")

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

            // Wait for task to complete
            await streamTask?.value

        } catch {
            self.error = "Failed to create conversation: \(error.localizedDescription)"
            print("❌ Failed to create conversation: \(error)")

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
