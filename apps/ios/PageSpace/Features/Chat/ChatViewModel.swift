import Foundation
import Combine

@MainActor
class ChatViewModel: ObservableObject {
    let conversationId: String

    @Published var messages: [Message] = []
    @Published var conversation: Conversation?
    @Published var isLoading = false
    @Published var isStreaming = false
    @Published var error: String?

    private let aiService = AIService.shared
    private let conversationService = ConversationService.shared
    private var streamingMessage: StreamingMessage?

    init(conversationId: String) {
        self.conversationId = conversationId
    }

    // MARK: - Load Messages

    func loadMessages() async {
        isLoading = true
        error = nil

        do {
            // Load conversation details
            conversation = try await conversationService.getConversation(conversationId)

            // Load messages
            let response = try await aiService.loadMessages(conversationId: conversationId)
            messages = response.messages

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
            // Include entire message history
            let stream = aiService.sendMessage(
                conversationId: conversationId,
                messages: messages
            )

            // Process stream chunks
            for try await chunk in stream {
                processStreamChunk(chunk)
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
}
