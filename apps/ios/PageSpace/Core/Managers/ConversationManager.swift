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

    /// Messages for the current conversation
    @Published var messages: [Message] = []

    /// Loading state for conversation switching
    @Published var isLoadingConversation = false

    /// Streaming state for message sending
    @Published var isStreaming = false

    /// Error message if any
    @Published var error: String?

    // MARK: - Services

    private let conversationService = ConversationService.shared
    private let aiService = AIService.shared
    private var streamingMessage: StreamingMessage?

    private init() {}

    // MARK: - Load Conversation (Atomic Operation)

    /// Load a specific conversation's messages
    /// This is an atomic operation - old messages are cleared before new ones load
    func loadConversation(_ conversationId: String) async {
        // Guard against redundant loads
        guard conversationId != currentConversationId else {
            print("ℹ️ Conversation \(conversationId) already loaded")
            return
        }

        print("🟢 ConversationManager.loadConversation - loading: \(conversationId)")

        isLoadingConversation = true
        error = nil

        // CRITICAL: Clear old messages immediately
        messages = []

        do {
            // Fetch messages from API
            let response = try await aiService.loadMessages(conversationId: conversationId)

            // Atomic update - only set if still loading this conversation
            // (guards against race conditions if user quickly switches conversations)
            if isLoadingConversation {
                messages = response.messages
                currentConversationId = conversationId
                print("✅ Loaded \(messages.count) messages for conversation: \(conversationId)")
            }
        } catch {
            self.error = "Failed to load conversation: \(error.localizedDescription)"
            print("❌ Failed to load conversation \(conversationId): \(error)")
        }

        isLoadingConversation = false
    }

    // MARK: - Create New Conversation

    /// Start a new conversation (clears current state)
    func createNewConversation() {
        print("🆕 ConversationManager.createNewConversation")
        currentConversationId = nil
        messages = []
        error = nil
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

        // Create streaming message for assistant
        let assistantMessageId = UUID().uuidString
        streamingMessage = StreamingMessage(id: assistantMessageId, role: .assistant)

        isStreaming = true
        error = nil

        do {
            // Auto-create conversation if needed (for new conversations)
            var conversationId = currentConversationId

            if conversationId == nil {
                print("ℹ️ Creating new global conversation for first message")
                // Don't set a title - let backend auto-generate from first message
                let newConversation = try await conversationService.createConversation(title: nil)
                conversationId = newConversation.id
                currentConversationId = conversationId
                print("✅ Created global conversation: \(conversationId!)")
            }

            guard let finalConversationId = conversationId else {
                throw NSError(
                    domain: "ConversationManager",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to get or create conversation ID"]
                )
            }

            // Stream message
            let stream = aiService.sendMessage(
                conversationId: finalConversationId,
                messages: messages
            )

            for try await chunk in stream {
                processStreamChunk(chunk)
            }

            print("✅ Message sent successfully")

        } catch {
            self.error = "Failed to send message: \(error.localizedDescription)"
            print("❌ Failed to send message: \(error)")

            // Remove incomplete streaming message on error
            if let streamingMessageId = streamingMessage?.id {
                messages.removeAll { $0.id == streamingMessageId }
            }
            streamingMessage = nil
        }

        isStreaming = false
        streamingMessage = nil
    }

    // MARK: - Stream Processing

    private func processStreamChunk(_ chunk: StreamChunk) {
        guard var currentMessage = streamingMessage else { return }

        switch chunk.type {
        case "text-delta":
            if let text = chunk.delta {
                currentMessage.appendText(text)
                streamingMessage = currentMessage
                updateStreamingMessageInUI()
            }

        case let type where type.hasPrefix("tool-"):
            // Handle any tool type (e.g., "tool-list_drives", "tool-read_page")
            if let toolCall = chunk.toolCall {
                let toolPart = ToolPart(
                    type: chunk.type,
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    input: toolCall.input != nil ? ["data": toolCall.input!] : nil,
                    output: nil,
                    state: .inputAvailable
                )
                currentMessage.addTool(toolPart)
                streamingMessage = currentMessage
                updateStreamingMessageInUI()
            } else if let toolResult = chunk.toolResult {
                // Update existing tool with output
                currentMessage.updateTool(
                    toolCallId: toolResult.toolCallId,
                    output: toolResult.result,
                    state: toolResult.isError == true ? .outputError : .outputAvailable
                )
                streamingMessage = currentMessage
                updateStreamingMessageInUI()
            }

        case "finish":
            currentMessage.isComplete = true
            streamingMessage = currentMessage

        default:
            break
        }
    }

    private func updateStreamingMessageInUI() {
        guard let streamingMessage = streamingMessage else { return }

        // Remove previous streaming message if exists
        messages.removeAll { $0.id == streamingMessage.id }

        // Add updated streaming message
        messages.append(streamingMessage.toMessage())
    }
}

// MARK: - Streaming Message Helper
// NOTE: StreamingMessage is defined in Message.swift
