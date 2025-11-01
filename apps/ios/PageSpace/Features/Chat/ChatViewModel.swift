import Foundation
import Combine

@MainActor
class ChatViewModel: ObservableObject {
    let agent: Agent

    @Published var messages: [Message] = []
    @Published var isLoading = false
    @Published var isStreaming = false
    @Published var error: String?

    private let aiService = AIService.shared
    private let pageAIService = PageAIService.shared
    private let conversationService = ConversationService.shared
    private let agentService = AgentService.shared
    private var streamingMessage: StreamingMessage?

    // Track conversationId separately in case agent doesn't have one yet
    private var activeConversationId: String?

    init(agent: Agent) {
        self.agent = agent
        // Always start with a fresh conversation (user requirement)
        // A new conversation will be created on first message
        self.activeConversationId = nil
    }

    // MARK: - Load Messages

    func loadMessages() async {
        isLoading = true
        error = nil

        do {
            switch agent.type {
            case .global:
                // Load from Global AI conversation
                guard let conversationId = activeConversationId else {
                    // New user with no conversation yet - show empty messages
                    messages = []
                    isLoading = false
                    return
                }

                let response = try await aiService.loadMessages(conversationId: conversationId)
                messages = response.messages

            case .pageAI:
                // Load from Page AI
                guard let pageId = agent.pageId else {
                    throw NSError(domain: "UnifiedChatViewModel", code: 2, userInfo: [NSLocalizedDescriptionKey: "No page ID for page AI agent"])
                }

                messages = try await pageAIService.loadMessages(pageId: pageId)
            }

        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    // MARK: - Send Message

    func sendMessage(_ text: String) async {
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
            switch agent.type {
            case .global:
                try await sendGlobalMessage(userMessage)

            case .pageAI:
                try await sendPageMessage(userMessage)
            }

            // Streaming message already in UI from updateStreamingMessageInUI()
            // No need to append again - it's already there!

        } catch {
            self.error = error.localizedDescription
            // Remove incomplete streaming message on error
            if let streamingMessageId = streamingMessage?.id {
                messages.removeAll { $0.id == streamingMessageId }
            }
            streamingMessage = nil
        }

        isStreaming = false
        streamingMessage = nil
    }

    // MARK: - Send to Global AI

    private func sendGlobalMessage(_ userMessage: Message) async throws {
        // Auto-create conversation if needed (for new users)
        var conversationId = activeConversationId

        if conversationId == nil {
            print("ℹ️ Creating new global conversation for first message")
            let newConversation = try await conversationService.createConversation(title: "Global Assistant")
            conversationId = newConversation.id
            activeConversationId = conversationId
            print("✅ Created global conversation: \(conversationId!)")

            // Update the agent in AgentService with the new conversationId
            agentService.updateGlobalAgentConversationId(conversationId!)
        }

        guard let finalConversationId = conversationId else {
            throw NSError(domain: "UnifiedChatViewModel", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to get or create conversation ID"])
        }

        let stream = aiService.sendMessage(
            conversationId: finalConversationId,
            messages: messages
        )

        for try await chunk in stream {
            processStreamChunk(chunk)
        }
    }

    // MARK: - Send to Page AI

    private func sendPageMessage(_ userMessage: Message) async throws {
        guard let pageId = agent.pageId else {
            throw NSError(domain: "UnifiedChatViewModel", code: 2, userInfo: [NSLocalizedDescriptionKey: "No page ID"])
        }

        // Build page context
        let pageContext = PageAIMessageRequest.PageContext(
            pageId: pageId,
            pageTitle: agent.title,
            pageType: "AI_CHAT",
            pagePath: agent.pagePath ?? "/",
            parentPath: nil,
            breadcrumbs: buildBreadcrumbs(),
            driveId: agent.driveId ?? "",
            driveName: agent.driveName ?? "",
            driveSlug: agent.driveId ?? ""
        )

        let stream = pageAIService.sendMessage(
            pageId: pageId,
            messages: messages,
            pageContext: pageContext
        )

        for try await chunk in stream {
            processStreamChunk(chunk)
        }
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

        case "tool-call":
            if let toolCall = chunk.toolCall {
                let toolPart = ToolCallPart(
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    input: toolCall.input
                )
                currentMessage.addToolCall(toolPart)
                streamingMessage = currentMessage
                updateStreamingMessageInUI()
            }

        case "tool-result":
            if let toolResult = chunk.toolResult {
                let resultPart = ToolResultPart(
                    toolCallId: toolResult.toolCallId,
                    result: toolResult.result,
                    isError: toolResult.isError ?? false
                )
                currentMessage.addToolResult(resultPart)
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

    private func buildBreadcrumbs() -> [String] {
        // Build breadcrumbs from agent path
        guard let path = agent.pagePath else { return [] }
        return path.split(separator: "/").map(String.init)
    }
}
