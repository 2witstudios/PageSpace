//
//  StreamingState.swift
//  PageSpace
//
//  Created by Claude Code on 2025-11-05.
//  Purpose: Isolated state management for streaming message updates
//  Prevents message list rebuilds during streaming by isolating streaming state
//

import Foundation
import Observation

/// Observable state object managing the currently streaming message
/// Isolated from MessageState to prevent full view rebuilds during streaming updates
@Observable
final class StreamingState {

    // MARK: - Properties

    /// The currently streaming message (if any)
    private(set) var streamingMessage: Message?

    /// Whether a message is currently being streamed
    private(set) var isStreaming: Bool = false

    /// Internal builder for accumulating streaming content
    private var streamingMessageBuilder: StreamingMessage?

    /// Throttle for batching UI updates
    private let streamThrottle: StreamThrottle

    /// Configuration for throttle interval (default 50ms)
    private let throttleInterval: TimeInterval

    // MARK: - Initialization

    init(throttleInterval: TimeInterval = 0.05) {
        self.throttleInterval = throttleInterval
        self.streamThrottle = StreamThrottle(interval: throttleInterval)
    }

    // MARK: - Public Methods

    /// Start a new streaming message
    func startStreaming(id: String, role: MessageRole) {
        isStreaming = true
        streamingMessageBuilder = StreamingMessage(id: id, role: role)
        // Set initial streaming message immediately
        streamingMessage = streamingMessageBuilder?.toMessage()
    }

    /// Append text to the streaming message (throttled)
    func appendText(_ text: String, immediate: Bool = false) {
        guard var builder = streamingMessageBuilder else { return }

        builder.appendText(text)
        streamingMessageBuilder = builder

        if immediate {
            // Bypass throttle for instant feedback (first chunk)
            publishStreamingMessage()
        } else {
            // Schedule throttled update
            scheduleStreamingUpdate()
        }
    }

    /// Update or add a tool call to the streaming message
    func updateTool(_ tool: ToolPart) {
        guard var builder = streamingMessageBuilder else { return }

        builder.updateOrAddTool(tool)
        streamingMessageBuilder = builder

        // Tool updates are immediate (not throttled)
        publishStreamingMessage()
    }

    /// Update tool output and state
    func updateToolOutput(toolCallId: String, output: AnyCodable?, state: ToolState) {
        guard var builder = streamingMessageBuilder else { return }

        builder.updateTool(toolCallId: toolCallId, output: output, state: state)
        streamingMessageBuilder = builder

        // Tool updates are immediate
        publishStreamingMessage()
    }

    /// Complete the streaming message and return it
    func completeStreaming() -> Message? {
        // Flush any pending throttled updates
        streamThrottle.flush()

        guard let builder = streamingMessageBuilder else { return nil }

        let completedMessage = builder.toMessage()

        // Clear streaming state
        streamingMessage = nil
        streamingMessageBuilder = nil
        isStreaming = false

        return completedMessage
    }

    /// Cancel streaming and clear state
    func cancelStreaming() {
        streamThrottle.cancel()
        streamingMessage = nil
        streamingMessageBuilder = nil
        isStreaming = false
    }

    /// Clear streaming state without returning message
    func clear() {
        streamThrottle.cancel()
        streamingMessage = nil
        streamingMessageBuilder = nil
        isStreaming = false
    }

    // MARK: - Private Methods

    /// Schedule a throttled update to the streaming message
    private func scheduleStreamingUpdate() {
        streamThrottle.execute { [weak self] in
            self?.publishStreamingMessage()
        }
    }

    /// Publish the current streaming message to observers
    private func publishStreamingMessage() {
        guard let builder = streamingMessageBuilder else { return }
        streamingMessage = builder.toMessage()
    }
}
